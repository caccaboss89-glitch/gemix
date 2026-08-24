// src/tools/imagineGenerator.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Grok Imagine - generate images and short videos on the direct xAI API:
//   - POST /v1/images/generations  (text-to-image)
//   - POST /v1/images/edits        (image generation guided by reference images)
//   - POST /v1/videos/generations + GET /v1/videos/{request_id} (async video)
//
// Reference images: entries that are already public URLs go straight through;
// a namespace path is read off disk and sent as an inline base64 data URL, so
// no file of the user's is published to a third party on the way to xAI.
// The generated media is downloaded into `workspace/`, and the tool answers
// with its path — plus, for an image, an inline copy so the model sees it.
//
// `generate_image` is the one tool with two backends behind it:
// Grok Imagine where the profile has it, Cloudflare FLUX otherwise and as the
// fallback. The routing and the fallback rules live in media/imageBackends.js;
// what stays here is the xAI half and the parts both share — prompt cleaning,
// the weekly quota, staging the result.

import path from 'path';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { getXaiServiceAuth  } from '../ai/credentials/xaiServiceCredentials.js';
import { callApiWithRetry, logApiResponse, fetchXaiWithOAuthRetry  } from '../ai/apiClient.js';
import { downloadPublicFile  } from '../utils/fetch.js';
import { resolveLocalFileEntry  } from '../utils/deliverySelection.js';
import { readAgentFileBuffer } from '../sandbox/hostFileGateway.js';
import { resolveWorkspaceId  } from '../utils/workspaceId.js';
import { stageToolOutput  } from './workspace/toolOutput.js';
import { INLINE_IMAGE_EXTS, inlineImagePartFromBuffer  } from './workspace/inlineImage.js';
import {
  BACKEND,
  FLUX_SIZES,
  failurePlan,
  generateWithFlux,
  resolveImageBackends,
  startCooldown
} from '../media/imageBackends.js';
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';
import { sanitizeFilename  } from '../utils/text.js';
import { createLogger  } from '../utils/logger.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import { reserveGeneration  } from '../utils/mediaUsageLimits.js';
import { sleepWithin } from '../utils/turnBudget.js';

const log = createLogger('ImagineGenerator');

// -- Limits -----------------------------------------------------------------

const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
// Video generation is async: POST returns a request_id, then we poll.
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_POLL_FETCH_TIMEOUT_MS = 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_429_POLLS = 5;
const VIDEO_IN_PROGRESS_STATUSES = new Set([
  '', 'pending', 'processing', 'queued', 'running', 'in_progress', 'in progress'
]);
// "expired" is documented alongside "failed" as a terminal poll status.
const VIDEO_TERMINAL_FAILURE_STATUSES = new Set([
  'failed', 'expired', 'error', 'rejected', 'cancelled', 'canceled'
]);

// Cap on the prompt to keep request payloads reasonable.
const MAX_PROMPT_LEN = 2000;

const ALLOWED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// /images/edits accepts up to 3 reference images (documented xAI limit).
// Reference-to-video publishes no count limit, so 7 is our own cap; both are
// checked before the request so the model gets the error without a round trip.
// They live in constants.js because the tool schemas quote them too.
const { MAX_REF_IMAGES_FOR_IMAGE, MAX_REF_IMAGES_FOR_VIDEO } = constants;

// Generated image/video download cap (same as the ingress video limit).
const GENERATED_MEDIA_MAX_BYTES = constants.MAX_VIDEO_BYTES;

// -- Helpers -----------------------------------------------------------------

/**
 * Sanitize the prompt: strip control chars, collapse whitespace, trim, cap length.
 */
function _cleanPrompt(prompt) {
  if (typeof prompt !== 'string') return { prompt: '', truncated: false };
  let p = prompt

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
 * Read one local reference image off disk, with the type and size checks that
 * make a bad reference cost no round trip.
 *
 * @returns {{ ok: true, buffer: Buffer, name: string, mime: string }|{ ok: false, reason: string }}
 */
function _openReferenceImage(entry, workspaceId) {
  const found = resolveLocalFileEntry(entry, workspaceId);
  if (!found) {
    return { ok: false, reason: `Reference image "${entry}" does not exist. Pass the path exactly as you saw it.` };
  }
  const ext = path.extname(found.name).toLowerCase();
  if (!INLINE_IMAGE_EXTS.has(ext)) {
    return {
      ok: false,
      reason: `Reference "${entry}" is not a supported image type (allowed: ${[...INLINE_IMAGE_EXTS].join(', ')}).`
    };
  }
  let opened;
  try {
    opened = readAgentFileBuffer(workspaceId, found.display, constants.MAX_IMAGE_BYTES);
  } catch (err) {
    if (err?.code === 'EFILETOOLARGE') {
      return { ok: false, reason: `Reference "${entry}" exceeds the ${Math.round(constants.MAX_IMAGE_BYTES / 1024 / 1024)} MB limit.` };
    }
    return { ok: false, reason: `Cannot read reference "${entry}": ${err.message}` };
  }
  if (!opened) return { ok: false, reason: `Cannot safely read reference "${entry}".` };
  if (opened.buffer.length === 0) return { ok: false, reason: `Reference "${entry}" is empty.` };
  return { ok: true, buffer: opened.buffer, name: found.name, mime: mimeForExtension(ext, 'image/png') };
}

/**
 * Resolve reference-image entries into the shape one backend accepts.
 *
 * The count cap is enforced here for every backend, since it is the tool schema
 * that advertises it. A local file is read off disk either way: as an inline
 * base64 data URL, which keeps a user file off any third-party host on the way
 * to the provider, or as raw bytes for a backend that uploads them itself.
 *
 * A public URL only travels where the backend takes one. Fetching it here to
 * re-upload it would be a different decision from the one the model made.
 *
 * @param {string[]} refList
 * @param {{ max: number, shape: 'data-url'|'bytes', allowUrls: boolean }} opts
 * @param {string} workspaceId
 * @returns {{ ok: true, items: Array }|{ ok: false, reason: string }}
 */
function _resolveReferenceImages(refList, { max, shape, allowUrls }, workspaceId) {
  if (refList.length > max) {
    return { ok: false, reason: `Too many reference images (${refList.length}). Max allowed: ${max}.` };
  }
  const items = [];
  for (const raw of refList) {
    const entry = typeof raw === 'string' ? raw.trim() : '';
    if (!entry) {
      return { ok: false, reason: 'Each reference image must be a workspace/attachments path or a public https URL.' };
    }
    if (/^https?:\/\//i.test(entry)) {
      if (!allowUrls) {
        return { ok: false, reason: 'This backend takes reference images from this chat, not from a URL. '
          + 'Download it into the workspace with shell first, then pass that path.' };
      }
      items.push(entry);
      continue;
    }
    const opened = _openReferenceImage(entry, workspaceId);
    if (!opened.ok) return opened;
    items.push(shape === 'data-url'
      ? `data:${opened.mime};base64,${opened.buffer.toString('base64')}`
      : { buffer: opened.buffer, name: opened.name, mime: opened.mime });
  }
  return { ok: true, items };
}

/**
 * An xAI failure, in the vocabulary the fallback policy speaks. Without this
 * the policy could only ever be applied to the Cloudflare half, and rule 2
 * (never route around a content refusal) would silently not hold for Imagine.
 */
function _classifyXaiFailure(message) {
  const m = String(message || '');
  if (/content policy|moderation|safety|prohibited|violat/i.test(m)) return 'CONTENT_POLICY';
  if (/\b429\b|rate.?limit|too many requests|quota|credit/i.test(m)) return 'RATE_LIMIT';
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.*(key|token)/i.test(m)) return 'AUTH';
  if (/\b5\d{2}\b|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i.test(m)) return 'TRANSIENT';
  return 'MALFORMED';
}

async function _downloadMedia(url, signal) {
  const result = await downloadPublicFile(url, {
    signal,
    timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
    maxBytes: GENERATED_MEDIA_MAX_BYTES
  });
  return result.buffer;
}

/**
 * Resolve the references, then POST to an Imagine endpoint. References travel
 * inline, so there is no hosted URL that can go stale between the two steps.
 */
async function _xaiImagineSubmit({
  label,
  timeoutMs,
  refList,
  maxRefs,
  workspaceId,
  buildRequest,
  signal
}) {
  const refs = _resolveReferenceImages(
    refList,
    { max: maxRefs, shape: 'data-url', allowUrls: true },
    workspaceId
  );
  if (!refs.ok) return { ok: false, reason: refs.reason };
  try {
    const { endpointPath, body } = buildRequest(refs.items);
    const data = await _xaiJsonRequest(label, endpointPath, body, timeoutMs, signal);
    return { ok: true, data, refCount: refs.items.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function _extFromGeneratedMedia(url, mimeType, fallbackExt) {
  if (typeof mimeType === 'string' && mimeType.includes('/')) {
    const fromMime = mimeType.split('/')[1].split(';')[0].trim().toLowerCase();
    if (/^[a-z0-9]+$/.test(fromMime)) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  }
  const m = String(url || '').match(/\.(png|jpe?g|webp|mp4|webm|mov)(?:\?|$)/i);
  return (m && m[1]) ? m[1].toLowerCase() : fallbackExt;
}

/** Land the generated bytes in the workspace under a name taken from the prompt. */
async function _stageGeneratedMedia(workspaceId, prompt, buffer, ext, fallbackBase) {
  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || fallbackBase;
  return stageToolOutput(workspaceId, `${baseName}_${Date.now()}.${ext}`, buffer);
}

/** HTTP statuses worth retrying during async job polling (transient server / rate limit). */
function _isRetryablePollHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function _isRetryablePollException(err) {
  const msg = err?.message || '';
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (m) return _isRetryablePollHttpStatus(Number(m[1]));
  return /ECONNRESET|ECONNREFUSED|ERR_NETWORK|fetch failed|network|socket hang up/i.test(msg);
}

function _videoPollFailureMessage(data, status) {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (data?.error?.message) return String(data.error.message);
  if (data?.message) return String(data.message);
  return `generation status "${status || 'failed'}"`;
}

async function _xaiJsonRequest(label, endpointPath, body, timeoutMs, signal) {
  const { baseUrl } = await getXaiServiceAuth();
  const url = `${baseUrl}${endpointPath}`;
  const res = await callApiWithRetry(label, url, body, {}, timeoutMs, { signal });
  const data = await res.json();
  logApiResponse(label, url, data);
  return data;
}

// -- generate_image ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - namespace paths or public https URLs (max 3).
 * @param {string} [args.aspect_ratio] - pure text-to-image only (edits respect the input image).
 * @param {object} userCtx
 * @returns {Promise<object|Array>} the `{ success, message?, path?, error? }` envelope,
 *   or — when the generated image is put in front of the model —
 *   `[input_text(envelope JSON), input_image]`, the multipart tool result the
 *   dispatcher forwards as it is.
 */
async function generateImage(args, userCtx) {
  if (!envConfig.IMAGE_GEN_MODEL) return { success: false, error: 'envConfig.IMAGE_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the image to generate.' };
  }

  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) {
    return { success: false, error: 'Could not resolve the workspace for this context.' };
  }

  const { primary, fallback } = resolveImageBackends();
  if (!primary) {
    return { success: false, error: 'No image generation backend is available on this deployment.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const signal = userCtx?.turnBudget?.signal;

  // Each backend validates only the arguments its own schema advertises: the
  // xAI variant takes an aspect ratio, FLUX takes a named size, and neither
  // should be refused for the other one's field.
  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : null;
  const size = args && typeof args.size === 'string' ? args.size.trim() : '';
  if (primary === BACKEND.XAI && refList.length === 0 && aspect !== null
      && !ALLOWED_IMAGE_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_IMAGE_ASPECT_RATIOS].join(', ')}.`
    };
  }
  if (primary === BACKEND.CLOUDFLARE && size && !FLUX_SIZES[size.toLowerCase()]) {
    return {
      success: false,
      error: `Invalid size "${size}". Allowed: ${Object.keys(FLUX_SIZES).join(', ')}.`
    };
  }

  log.info(`generate_image: backends=${[primary, fallback].filter(Boolean).join(' -> ')}, `
    + `refs=${refList.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // Weekly per-user quota (admins exempt). Reserve the slot before the network
  // call so parallel calls in one round cannot exceed the cap; refund on failure.
  const quota = await reserveGeneration('image', userCtx);
  if (!quota.ok) return { success: false, error: quota.error };

  try {
    const attempt = await _runImageChain({
      primary,
      fallback,
      prompt,
      refList,
      aspect,
      size,
      workspaceId,
      signal
    });
    if (!attempt.ok) {
      return { success: false, error: `Image generation failed: ${attempt.error}` };
    }

    let staged;
    try {
      staged = await _stageGeneratedMedia(workspaceId, prompt, attempt.buffer, attempt.ext, 'image');
    } catch (err) {
      return { success: false, error: `Cannot save the generated image: ${err.message}` };
    }
    const visionPart = inlineImagePartFromBuffer(attempt.buffer, mimeForExtension(`.${attempt.ext}`, 'image/png'));

    const truncNote = truncated ? ' (prompt was truncated)' : '';
    const refNote = attempt.refCount > 0 ? ` Used ${attempt.refCount} reference image(s).` : '';
    const backendNote = attempt.backend !== primary
      ? ` The usual backend was unavailable, so this came from ${attempt.backend}.`
      : '';
    quota.commit();
    const payload = {
      success: true,
      path: staged.display,
      message: `Image generated successfully and saved as "${staged.display}".${refNote} `
        + `Pass that path to send it, or as a reference image in generate_image or generate_video.${truncNote}`
        + backendNote
        + (visionPart ? ' Attached below so you can see it.' : '')
    };
    return visionPart ? [{ type: 'input_text', text: JSON.stringify(payload) }, visionPart] : payload;
  } finally {
    await quota.release();
  }
}

/**
 * One attempt on the xAI Imagine image endpoints.
 * No references -> /images/generations; 1-3 references -> /images/edits.
 */
async function _attemptXaiImage({ prompt, refList, aspect, workspaceId, signal }) {
  const submit = await _xaiImagineSubmit({
    label: 'Grok-Imagine-Image',
    timeoutMs: IMAGE_TIMEOUT_MS,
    refList,
    maxRefs: MAX_REF_IMAGES_FOR_IMAGE,
    workspaceId,
    signal,
    buildRequest: (urls) => {
      const body = {
        model: envConfig.IMAGE_GEN_MODEL,
        prompt,
        response_format: 'url'
      };
      if (urls.length === 0) {
        if (aspect !== null) body.aspect_ratio = aspect;
        return { endpointPath: '/images/generations', body };
      }
      if (urls.length === 1) {
        body.image = { url: urls[0], type: 'image_url' };
      } else {
        body.images = urls.map(url => ({ type: 'image_url', url }));
      }
      return { endpointPath: '/images/edits', body };
    }
  });
  if (!submit.ok) return { ok: false, error: submit.reason, code: _classifyXaiFailure(submit.reason) };

  const item = Array.isArray(submit.data?.data) ? submit.data.data[0] : null;
  if (!item || typeof item.url !== 'string') {
    await notifyAdmin('GenerateImage', `No media URL in response: ${JSON.stringify(submit.data).slice(0, 300)}`);
    return { ok: false, error: `Image generation produced no media URL.${ADMIN_NOTIFIED_SUFFIX}`, code: 'MALFORMED' };
  }

  let buffer;
  try {
    buffer = await _downloadMedia(item.url, signal);
  } catch (err) {
    return { ok: false, error: `Image load failed: ${err.message}`, code: 'TRANSIENT' };
  }
  return {
    ok: true,
    buffer,
    ext: _extFromGeneratedMedia(item.url, item.mime_type, 'jpg'),
    refCount: submit.refCount
  };
}

/** One attempt on Cloudflare FLUX, with references read off disk as bytes. */
async function _attemptFluxImage({ prompt, refList, size, workspaceId, signal }) {
  const refs = _resolveReferenceImages(
    refList,
    { max: MAX_REF_IMAGES_FOR_IMAGE, shape: 'bytes', allowUrls: false },
    workspaceId
  );
  if (!refs.ok) return { ok: false, error: refs.reason, code: 'MALFORMED' };

  const result = await generateWithFlux({ prompt, size, references: refs.items, signal });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: true, buffer: result.buffer, ext: result.ext, refCount: refs.items.length };
}

/**
 * Try the primary, then the fallback, under the fallback policy. Never more than
 * one retry per backend and never a third backend, so this always terminates.
 */
async function _runImageChain({ primary, fallback, prompt, refList, aspect, size, workspaceId, signal }) {
  const run = (backend) => (backend === BACKEND.XAI
    ? _attemptXaiImage({ prompt, refList, aspect, workspaceId, signal })
    : _attemptFluxImage({ prompt, refList, size, workspaceId, signal }));

  let attempt = await run(primary);
  if (attempt.ok) return { ...attempt, backend: primary };
  if (signal?.aborted) return attempt;

  const plan = failurePlan(attempt.code);
  if (plan.cooldown) startCooldown(primary);

  if (plan.retryPrimary) {
    log.info(`   ${primary} failed (${attempt.code}); one more attempt before falling back`);
    attempt = await run(primary);
    if (attempt.ok) return { ...attempt, backend: primary };
    if (signal?.aborted) return attempt;
  }

  if (!plan.fallBack || !fallback) return attempt;

  log.info(`   ${primary} failed (${attempt.code}); falling back to ${fallback}`);
  const second = await run(fallback);
  if (second.ok) return { ...second, backend: fallback };
  // Both are spent, so the model gets one structured error, not a loop.
  return { ok: false, error: `${attempt.error} Fallback also failed: ${second.error}`, code: second.code };
}

// -- generate_video ----------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images] - namespace paths or public https URLs (max 7).
 * @param {string} [args.aspect_ratio]
 * @param {object} userCtx
 * @returns {Promise<{ success: boolean, message?: string, path?: string, error?: string }>}
 */
async function generateVideo(args, userCtx) {
  if (!envConfig.VIDEO_GEN_MODEL) return { success: false, error: 'envConfig.VIDEO_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the video to generate.' };
  }

  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) {
    return { success: false, error: 'Could not resolve the workspace for this context.' };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const signal = userCtx?.turnBudget?.signal;

  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : '16:9';
  if (refList.length === 0 && !ALLOWED_VIDEO_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_VIDEO_ASPECT_RATIOS].join(', ')}.`
    };
  }

  log.info(`generate_video: aspect=${refList.length === 0 ? aspect : 'auto'}, refs=${refList.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // Weekly per-user quota (admins exempt). Reserve the slot before the network
  // call so parallel calls in one round cannot exceed the cap; refund on failure.
  const quota = await reserveGeneration('video', userCtx);
  if (!quota.ok) return { success: false, error: quota.error };

  try {
    const submitResult = await _xaiImagineSubmit({
      label: 'Grok-Imagine-Video',
      timeoutMs: IMAGE_TIMEOUT_MS,
      refList,
      maxRefs: MAX_REF_IMAGES_FOR_VIDEO,
      workspaceId,
      signal,
      buildRequest: (urls) => {
        const body = {
          model: envConfig.VIDEO_GEN_MODEL,
          prompt,
          duration: constants.VIDEO_GEN_DURATION_S,
          resolution: constants.VIDEO_GEN_RESOLUTION
        };
        if (urls.length === 0) {
          body.aspect_ratio = aspect;
        } else if (urls.length === 1) {
          body.image = { url: urls[0], type: 'image_url' };
        } else {
          body.reference_images = urls.map(url => ({ type: 'image_url', url }));
        }
        return { endpointPath: '/videos/generations', body };
      }
    });
    if (!submitResult.ok) {
      return { success: false, error: `Video generation failed: ${submitResult.reason}` };
    }
    const submit = submitResult.data;
    const refCount = submitResult.refCount;

    const requestId = submit?.request_id;
    if (!requestId || typeof requestId !== 'string') {
      await notifyAdmin('GenerateVideo', `No request_id in response: ${JSON.stringify(submit).slice(0, 300)}`);
      return { success: false, error: `Video generation did not return a request id.${ADMIN_NOTIFIED_SUFFIX}` };
    }

    let videoUrl;
    try {
      videoUrl = await _pollVideoResult(requestId, signal);
    } catch (err) {
      if (signal?.aborted) {
        return { success: false, error: 'Video generation stopped because this turn ended.' };
      }
      await notifyAdmin('GenerateVideo', `Polling ${requestId} failed: ${err.message}`);
      return { success: false, error: `Video generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
    }

    let buffer;
    try {
      buffer = await _downloadMedia(videoUrl, signal);
    } catch (err) {
      if (signal?.aborted) {
        return { success: false, error: 'Video download stopped because this turn ended.' };
      }
      await notifyAdmin('GenerateVideo', `Load media from ${videoUrl} failed: ${err.message}`);
      return { success: false, error: `Video load failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
    }

    const ext = _extFromGeneratedMedia(videoUrl, null, 'mp4');
    let staged;
    try {
      staged = await _stageGeneratedMedia(workspaceId, prompt, buffer, ext, 'video');
    } catch (err) {
      return { success: false, error: `Cannot save the generated video: ${err.message}` };
    }

    const truncNote = truncated ? ' (prompt was truncated)' : '';
    const refNote = refCount > 0 ? ` Used ${refCount} reference image(s).` : '';
    quota.commit();
    return {
      success: true,
      path: staged.display,
      message: `Video generated successfully (${constants.VIDEO_GEN_DURATION_S}s, ${constants.VIDEO_GEN_RESOLUTION}) `
        + `and saved as "${staged.display}".${refNote}${truncNote} `
        + 'Open it with read_file to watch it, or pass that path to send it.'
    };
  } finally {
    await quota.release();
  }
}

/**
 * Poll GET /v1/videos/{request_id} until status "done", then return the
 * video URL. Throws on failure status or timeout.
 */
async function _pollVideoResult(requestId, signal) {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  const label = 'Grok-Imagine-Video-Poll';
  let consecutive429 = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');

    const { baseUrl } = await getXaiServiceAuth();
    const url = `${baseUrl}/videos/${encodeURIComponent(requestId)}`;
    let data;
    try {
      const res = await fetchXaiWithOAuthRetry(url, { method: 'GET' }, {
        timeoutMs: VIDEO_POLL_FETCH_TIMEOUT_MS,
        signal
      });
      consecutive429 = 0;
      data = await res.json();
    } catch (err) {
      const msg = err?.message || '';
      if (/^HTTP 429\b/.test(msg)) {
        consecutive429 += 1;
        if (consecutive429 >= MAX_CONSECUTIVE_429_POLLS) {
          throw new Error(`Rate limited too many times (${MAX_CONSECUTIVE_429_POLLS} consecutive 429s): ${msg}`);
        }
      }
      if (!_isRetryablePollException(err)) {
        throw err;
      }
      log.warn(`   video poll retry (${requestId}): ${msg}`);
      await sleepWithin(VIDEO_POLL_INTERVAL_MS, signal);
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
    if (VIDEO_TERMINAL_FAILURE_STATUSES.has(status) || data?.error) {
      logApiResponse(label, url, data);
      throw new Error(_videoPollFailureMessage(data, status));
    }
    if (!VIDEO_IN_PROGRESS_STATUSES.has(status)) {
      logApiResponse(label, url, data);
      throw new Error(_videoPollFailureMessage(data, status || 'unknown'));
    }
    log.debug(`   video ${requestId}: status=${status || 'pending'}`);
    await sleepWithin(VIDEO_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Timed out after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 1000)}s waiting for the video.`);
}

export {
  generateImage,
  generateVideo

};
