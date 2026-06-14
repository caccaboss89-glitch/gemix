// src/tools/imagineGenerator.js
//
// Grok Imagine - generate images and short videos on the direct xAI API:
//   - POST /v1/images/generations  (text-to-image)
//   - POST /v1/images/edits        (image generation guided by reference images)
//   - POST /v1/videos/generations + GET /v1/videos/{request_id} (async video)
//
// Reference images are passed as public HTTPS URLs: entries that are already
// URLs go straight through; local filenames (delivery buffer or chat history)
// are uploaded via utils/xaiUpload.js first. The generated media URL is
// downloaded and stored as a buffered attachment for delivery.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL,
} = require('../config/env');
const { getXaiAuth } = require('../config/xaiAuth');
const { callApiWithRetry, logApiResponse } = require('../ai/apiClient');
const { tempDirForOwner } = require('../utils/tempFileServer');
const { getHistoryDir, resolveStorageId } = require('../utils/userPaths');
const { resolveWorkspaceId, workspaceIdToSlug } = require('../utils/workspaceId');
const { pushBufferAttachment } = require('../utils/attachments');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');
const { mimeForExtension } = require('../config/mimeExtensions');
const { XAI_IMAGE_EXTS, exposeXaiUrlFromAbsPath } = require('../utils/aiFileDelivery');

const log = createLogger('ImagineGenerator');

// -- Limits -----------------------------------------------------------------

const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
// Video generation is async: POST returns a request_id, then we poll.
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 8 * 60 * 1000;

// Cap on the prompt to keep request payloads reasonable.
const MAX_PROMPT_LEN = 2000;

const ALLOWED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// xAI limits: /images/edits accepts up to 3 reference images; video
// generation accepts 1 (image-to-video) up to 7 (reference-to-video).
const MAX_REF_IMAGES_FOR_IMAGE = 3;
const MAX_REF_IMAGES_FOR_VIDEO = 7;

// Fixed video parameters.
const VIDEO_DURATION_S = 10;
const VIDEO_RESOLUTION = '720p';

// Single reference image size cap (guards the upload, not a base64 payload).
const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024;

// -- Helpers -----------------------------------------------------------------

/**
 * Sanitize the prompt: strip control chars, collapse whitespace, trim, cap length.
 */
function _cleanPrompt(prompt) {
  if (typeof prompt !== 'string') return { prompt: '', truncated: false };
  let p = prompt
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let truncated = false;
  if (p.length > MAX_PROMPT_LEN) {
    p = p.substring(0, MAX_PROMPT_LEN);
    truncated = true;
  }
  return { prompt: p, truncated };
}

/**
 * Locate a reference-image file by filename, mirroring the resolution policy
 * of read_file / the build tool:
 *   1. current-turn delivery buffer (responseCtx.attachments[]) by name
 *   2. chat history for this user
 *
 * Returns { filePath } | { buffer, name } on hit, null on miss. Only the
 * basename is honoured - the model passes plain filenames, never paths.
 */
function _findReferenceFile(filename, userCtx, responseCtx) {
  if (typeof filename !== 'string' || !filename.trim()) return null;
  const target = path.basename(filename.trim());

  if (Array.isArray(responseCtx && responseCtx.attachments)) {
    const buf = responseCtx.attachments.find(
      a => a && a.name && path.basename(a.name) === target,
    );
    if (buf) {
      if (buf.filePath && fs.existsSync(buf.filePath)) {
        return { filePath: buf.filePath, name: path.basename(buf.name) };
      }
      if (Buffer.isBuffer(buf.buffer)) {
        return { buffer: buf.buffer, name: path.basename(buf.name) };
      }
    }
  }

  const historyDir = getHistoryDir(userCtx);
  if (historyDir) {
    const candidate = path.join(historyDir, target);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { filePath: candidate, name: target };
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Persist a buffer-sourced reference image to the caller's private temp subdir
 * so it can be uploaded. Per-user isolation: files for one user never share a
 * directory with another's.
 */
function _materializeRefToTemp(buffer, name, ownerKey) {
  const dir = tempDirForOwner(ownerKey);
  const safe = (name || 'ref').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, `imgref_${crypto.randomBytes(8).toString('hex')}_${safe}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Resolve reference-image entries (public HTTPS URLs or local filenames) into
 * public HTTPS URLs xAI can fetch. Validates count, extension, and size.
 *
 * Returns { ok:true, urls:[] } or { ok:false, reason }.
 */
async function _resolveReferenceImageUrls(refList, max, userCtx, responseCtx) {
  if (refList.length > max) {
    return { ok: false, reason: `Too many reference images (${refList.length}). Max allowed: ${max}.` };
  }
  // Per-user temp subdir so buffer-materialized references stay isolated.
  const ownerKey = workspaceIdToSlug(resolveWorkspaceId(userCtx)) || resolveStorageId(userCtx) || null;
  const urls = [];
  for (const raw of refList) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: 'Each reference image must be a filename or a public https URL.' };
    }
    const entry = raw.trim();

    // Public URLs (e.g. images found via web/X search) pass straight through.
    if (/^https?:\/\//i.test(entry)) {
      urls.push(entry);
      continue;
    }

    const found = _findReferenceFile(entry, userCtx, responseCtx);
    if (!found) {
      return { ok: false, reason: `Reference image "${entry}" not found in the current attachments or chat history.` };
    }

    const ext = path.extname(found.name || entry).toLowerCase();
    if (!XAI_IMAGE_EXTS.has(ext)) {
      return {
        ok: false,
        reason: `Reference "${entry}" is not a supported image type (allowed: ${[...XAI_IMAGE_EXTS].join(', ')}).`,
      };
    }

    let diskPath = found.filePath || null;
    if (!diskPath) {
      if (found.buffer.length === 0) return { ok: false, reason: `Reference "${entry}" is empty.` };
      if (found.buffer.length > MAX_REF_IMAGE_BYTES) {
        return { ok: false, reason: `Reference "${entry}" exceeds the 8 MB limit.` };
      }
      try {
        diskPath = _materializeRefToTemp(found.buffer, found.name, ownerKey);
      } catch (err) {
        return { ok: false, reason: `Cannot stage reference "${entry}": ${err.message}` };
      }
    } else {
      try {
        const sz = fs.statSync(diskPath).size;
        if (sz === 0) return { ok: false, reason: `Reference "${entry}" is empty.` };
        if (sz > MAX_REF_IMAGE_BYTES) return { ok: false, reason: `Reference "${entry}" exceeds the 8 MB limit.` };
      } catch (err) {
        return { ok: false, reason: `Cannot read reference "${entry}": ${err.message}` };
      }
    }

    const exposed = await exposeXaiUrlFromAbsPath(diskPath, found.name || `ref${ext}`, {
      mimetype: mimeForExtension(ext),
    });
    if (!exposed.success) {
      return { ok: false, reason: exposed.error || `Cannot expose reference "${entry}" publicly.` };
    }
    urls.push(exposed.url);
  }
  return { ok: true, urls };
}

async function _downloadMedia(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const arrBuf = await res.arrayBuffer();
  if (!arrBuf || arrBuf.byteLength === 0) {
    throw new Error('Download returned an empty body.');
  }
  return Buffer.from(arrBuf);
}

function _extFromGeneratedMedia(url, mimeType, fallbackExt) {
  if (typeof mimeType === 'string' && mimeType.includes('/')) {
    const fromMime = mimeType.split('/')[1].split(';')[0].trim().toLowerCase();
    if (/^[a-z0-9]+$/.test(fromMime)) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  }
  const m = String(url || '').match(/\.(png|jpe?g|webp|mp4|webm|mov)(?:\?|$)/i);
  return (m && m[1]) ? m[1].toLowerCase() : fallbackExt;
}

function _pushGeneratedMedia(responseCtx, prompt, buffer, ext, fallbackBase) {
  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || fallbackBase;
  const desiredName = `${baseName}_${Date.now()}.${ext}`;
  const mimetype = mimeForExtension(`.${ext}`);
  return pushBufferAttachment(responseCtx, { name: desiredName, buffer, mimetype });
}

async function _xaiJsonRequest(label, endpointPath, body, timeoutMs) {
  const { baseUrl } = getXaiAuth();
  const url = `${baseUrl}${endpointPath}`;
  const res = await callApiWithRetry(label, url, body, {}, timeoutMs);
  const data = await res.json();
  logApiResponse(label, url, data);
  return data;
}

// -- generate_image ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - filenames or public https URLs (max 3).
 * @param {string} [args.aspect_ratio] - pure text-to-image only (edits respect the input image).
 * @param {object} userCtx
 * @param {object} responseCtx
 */
async function generateImage(args, userCtx, responseCtx) {
  if (!IMAGE_GEN_MODEL) return { success: false, error: 'IMAGE_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the image to generate.' };
  }

  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const refs = await _resolveReferenceImageUrls(refList, MAX_REF_IMAGES_FOR_IMAGE, userCtx, responseCtx);
  if (!refs.ok) {
    return { success: false, error: refs.reason };
  }

  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : null;
  if (refs.urls.length === 0 && aspect !== null && !ALLOWED_IMAGE_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_IMAGE_ASPECT_RATIOS].join(', ')}.`,
    };
  }

  // No references -> text-to-image on /images/generations.
  // 1 reference   -> /images/edits with the single `image` field.
  // 2-3 references -> /images/edits with the `images` array (order matters:
  //                  the model addresses them as <IMAGE_0>, <IMAGE_1>, ...).
  let endpointPath;
  const body = {
    model: IMAGE_GEN_MODEL,
    prompt,
    response_format: 'url',
  };
  if (refs.urls.length === 0) {
    endpointPath = '/images/generations';
    if (aspect !== null) body.aspect_ratio = aspect;
  } else {
    endpointPath = '/images/edits';
    if (refs.urls.length === 1) {
      body.image = { url: refs.urls[0], type: 'image_url' };
    } else {
      body.images = refs.urls.map(url => ({ type: 'image_url', url }));
    }
  }

  log.info(`generate_image: refs=${refs.urls.length}, aspect=${aspect || 'auto'}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  let data;
  try {
    data = await _xaiJsonRequest('Grok-Imagine-Image', endpointPath, body, IMAGE_TIMEOUT_MS);
  } catch (err) {
    return { success: false, error: `Image generation failed: ${err.message}` };
  }

  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (!item || typeof item.url !== 'string') {
    await notifyAdmin('GenerateImage', `No media URL in response: ${JSON.stringify(data).slice(0, 300)}`);
    return { success: false, error: `Image generation produced no media URL.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try {
    buffer = await _downloadMedia(item.url);
  } catch (err) {
    await notifyAdmin('GenerateImage', `Load media from ${item.url} failed: ${err.message}`);
    return { success: false, error: `Image load failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const ext = _extFromGeneratedMedia(item.url, item.mime_type, 'jpg');
  const filename = _pushGeneratedMedia(responseCtx, prompt, buffer, ext, 'image');

  const truncNote = truncated ? ' (prompt was truncated)' : '';
  return {
    success: true,
    filename,
    message: `Image generated successfully and pushed to the delivery buffer as "${filename}". `
      + `You can also pass this filename as a reference image in generate_image or generate_video.${truncNote}`,
  };
}

// -- generate_video ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - filenames or public https URLs (max 7).
 * @param {string} [args.aspect_ratio]
 * @param {object} userCtx
 * @param {object} responseCtx
 */
async function generateVideo(args, userCtx, responseCtx) {
  if (!VIDEO_GEN_MODEL) return { success: false, error: 'VIDEO_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the video to generate.' };
  }

  const aspect = (args && typeof args.aspect_ratio === 'string') ? args.aspect_ratio.trim() : '16:9';
  if (!ALLOWED_VIDEO_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_VIDEO_ASPECT_RATIOS].join(', ')}.`,
    };
  }

  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const refs = await _resolveReferenceImageUrls(refList, MAX_REF_IMAGES_FOR_VIDEO, userCtx, responseCtx);
  if (!refs.ok) {
    return { success: false, error: refs.reason };
  }

  // 1 reference  -> image-to-video (`image` is the starting frame).
  // 2-7 references -> reference-to-video (`reference_images` guide the clip).
  // The two fields are mutually exclusive per xAI docs.
  const body = {
    model: VIDEO_GEN_MODEL,
    prompt,
    duration: VIDEO_DURATION_S,
    aspect_ratio: aspect,
    resolution: VIDEO_RESOLUTION,
  };
  if (refs.urls.length === 1) {
    body.image = { url: refs.urls[0], type: 'image_url' };
  } else if (refs.urls.length > 1) {
    body.reference_images = refs.urls.map(url => ({ type: 'image_url', url }));
  }

  log.info(`generate_video: aspect=${aspect}, refs=${refs.urls.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  let submit;
  try {
    submit = await _xaiJsonRequest('Grok-Imagine-Video', '/videos/generations', body, IMAGE_TIMEOUT_MS);
  } catch (err) {
    return { success: false, error: `Video generation failed: ${err.message}` };
  }

  const requestId = submit?.request_id;
  if (!requestId || typeof requestId !== 'string') {
    await notifyAdmin('GenerateVideo', `No request_id in response: ${JSON.stringify(submit).slice(0, 300)}`);
    return { success: false, error: `Video generation did not return a request id.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let videoUrl;
  try {
    videoUrl = await _pollVideoResult(requestId);
  } catch (err) {
    await notifyAdmin('GenerateVideo', `Polling ${requestId} failed: ${err.message}`);
    return { success: false, error: `Video generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try {
    buffer = await _downloadMedia(videoUrl);
  } catch (err) {
    await notifyAdmin('GenerateVideo', `Load media from ${videoUrl} failed: ${err.message}`);
    return { success: false, error: `Video load failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const ext = _extFromGeneratedMedia(videoUrl, null, 'mp4');
  const filename = _pushGeneratedMedia(responseCtx, prompt, buffer, ext, 'video');

  const truncNote = truncated ? ' (prompt was truncated)' : '';
  const refNote = refs.urls.length > 0
    ? ` Used ${refs.urls.length} reference image(s).`
    : '';
  return {
    success: true,
    filename,
    message: `Video generated successfully (${VIDEO_DURATION_S}s, ${VIDEO_RESOLUTION}) and pushed to the delivery buffer as "${filename}".${refNote}${truncNote}`,
  };
}

/**
 * Poll GET /v1/videos/{request_id} until status "done", then return the
 * video URL. Throws on failure status or timeout.
 */
async function _pollVideoResult(requestId) {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  const label = 'Grok-Imagine-Video-Poll';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL_MS));

    const { baseUrl, token } = getXaiAuth();
    const url = `${baseUrl}/videos/${encodeURIComponent(requestId)}`;
    let data;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      data = await res.json();
    } catch (err) {
      // Transient polling errors are retried until the deadline.
      log.warn(`   video poll error (${requestId}): ${err.message}`);
      continue;
    }

    const status = String(data?.status || '').toLowerCase();
    if (status === 'done') {
      logApiResponse(label, url, data);
      const videoUrl = data?.video?.url;
      if (typeof videoUrl !== 'string' || !videoUrl) {
        throw new Error('status "done" but no video URL in response');
      }
      return videoUrl;
    }
    if (status === 'failed' || status === 'error' || data?.error) {
      logApiResponse(label, url, data);
      throw new Error(data?.error?.message || data?.error || `generation status "${status}"`);
    }
    log.debug(`   video ${requestId}: status=${status || 'pending'}`);
  }
  throw new Error(`Timed out after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 1000)}s waiting for the video.`);
}

module.exports = { generateImage, generateVideo };
