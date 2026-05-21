// src/tools/imagineGenerator.js
//
// Grok Imagine — generate images and short videos via the Hermes proxy.
//
// Endpoints (proxied to xAI by Hermes; auth uses HERMES_API_KEY → SuperGrok OAuth):
//   POST {HERMES_BASE_URL}/images/generations  (model: IMAGE_GEN_MODEL)
//   POST {HERMES_BASE_URL}/videos/generations  (model: VIDEO_GEN_MODEL)
//
// Reference images are resolved through the same path rules used by read_file
// (chat history, /readonly/searched_images, /workspace/...). They are read
// from disk, validated as image files, and forwarded as base64 in the
// request body. We never accept URLs or arbitrary buffers — the AI can only
// reference files it could already read.
//
// We always request `response_format: "b64_json"` so the result is a Buffer
// we can hand straight to responseCtx.attachments. URLs from xAI are
// short-lived, base64 is more reliable for our delivery pipeline.

const fs = require('fs');
const path = require('path');
const {
  HERMES_API_KEY,
  HERMES_BASE_URL,
  IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL,
} = require('../config/env');
const { logApiRequest, logApiResponse } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { isPathAllowed, ensureUserSkeleton, resolveStorageId } = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');

const log = createLogger('ImagineGenerator');

// ── Endpoints ───────────────────────────────────────────────────────────────

const IMAGE_GEN_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/images/generations`;
const VIDEO_GEN_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/videos/generations`;

// ── Limits ──────────────────────────────────────────────────────────────────

// Image generation tends to take 5-30 s; video generation 30-120 s.
const IMAGE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

// xAI Imagine accepts up to 3 reference images for image-to-image / editing
// and up to 7 for reference-to-video. Hard caps so the AI cannot ask for more.
const MAX_REF_IMAGES_FOR_IMAGE = 3;
const MAX_REF_IMAGES_FOR_VIDEO = 7;

// Maximum size for a single reference image (base64 inflates ~33%).
const MAX_REF_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

const MAX_PROMPT_LEN = 2000;

const ALLOWED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16']);

const IMAGE_EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve a reference-image path provided by the AI.
 *
 * Non-agentic mode: the AI is told to use bare history filenames
 * ("photo.jpg", "subdir/photo.jpg"). We auto-prefix with `history/`.
 *
 * Agentic mode: absolute paths are mandatory: /readonly/history/...,
 * /readonly/searched_images/..., or /workspace/{temp|output|code}/...
 * Bare filenames still work and resolve to chat history.
 *
 * @param {string} rawPath
 * @param {object} userCtx
 * @returns {Promise<{ok: boolean, absPath?: string, displayPath?: string, reason?: string}>}
 */
async function _resolveReferencePath(rawPath, userCtx) {
  const agenticUnlocked = Boolean(userCtx.agenticUnlocked);
  let normalized = (rawPath || '').trim();

  if (!normalized) {
    return { ok: false, reason: 'Empty reference image path.' };
  }

  // Non-agentic: rewrite bare names to history/ (mirrors read_file behaviour).
  if (!agenticUnlocked && !normalized.startsWith('/') && !normalized.startsWith('skills:')) {
    if (normalized.startsWith('./')) normalized = normalized.slice(2);
    if (!normalized.startsWith('history/')) normalized = 'history/' + normalized;
  }

  const currentProject = await getCurrentProject(userCtx);
  const check = isPathAllowed(userCtx, normalized, { op: 'read', currentProject, agenticUnlocked });
  if (!check.ok) return { ok: false, reason: check.reason };
  if (check.zone === 'skills') {
    return { ok: false, reason: 'skills/ files cannot be used as reference images.' };
  }

  return { ok: true, absPath: check.absPath, displayPath: rawPath };
}

/**
 * Read a reference image from disk and return { buffer, mime, base64 }.
 * Validates extension, MIME, and size.
 */
function _loadReferenceImage(absPath, displayPath) {
  let stat;
  try { stat = fs.statSync(absPath); } catch (e) {
    return { ok: false, reason: `Cannot access "${displayPath}": ${e.message}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `"${displayPath}" is not a file.` };
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime = IMAGE_EXT_TO_MIME[ext];
  if (!mime) {
    return {
      ok: false,
      reason: `"${displayPath}" is not a supported image (allowed: ${Object.keys(IMAGE_EXT_TO_MIME).join(', ')}).`,
    };
  }
  if (stat.size === 0) {
    return { ok: false, reason: `"${displayPath}" is empty.` };
  }
  if (stat.size > MAX_REF_IMAGE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `"${displayPath}" is too large (${mb} MB). Max allowed: ${MAX_REF_IMAGE_BYTES / (1024 * 1024)} MB.`,
    };
  }

  let buffer;
  try { buffer = fs.readFileSync(absPath); }
  catch (e) { return { ok: false, reason: `Cannot read "${displayPath}": ${e.message}` }; }

  return {
    ok: true,
    buffer,
    mime,
    base64: buffer.toString('base64'),
  };
}

/**
 * Sanitize the prompt: strip control chars, collapse whitespace, trim, cap length.
 */
function _cleanPrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  let p = prompt
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  let truncated = false;
  if (p.length > MAX_PROMPT_LEN) {
    p = p.substring(0, MAX_PROMPT_LEN);
    truncated = true;
  }
  return { prompt: p, truncated };
}

/**
 * Resolve a list of reference image paths into their base64 representations.
 * Returns { ok, items: [{base64, mime, displayPath}], reason? }.
 */
async function _resolveReferenceImages(refPaths, max, userCtx) {
  if (!Array.isArray(refPaths) || refPaths.length === 0) {
    return { ok: true, items: [] };
  }
  if (refPaths.length > max) {
    return {
      ok: false,
      reason: `Too many reference images (${refPaths.length}). Max allowed: ${max}.`,
    };
  }

  ensureUserSkeleton(userCtx);

  const items = [];
  for (const raw of refPaths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: 'Each reference image entry must be a non-empty string path.' };
    }
    const resolved = await _resolveReferencePath(raw, userCtx);
    if (!resolved.ok) {
      return { ok: false, reason: `Reference image "${raw}" rejected: ${resolved.reason}` };
    }
    const loaded = _loadReferenceImage(resolved.absPath, resolved.displayPath);
    if (!loaded.ok) {
      return { ok: false, reason: loaded.reason };
    }
    items.push({
      base64: loaded.base64,
      mime: loaded.mime,
      displayPath: resolved.displayPath,
    });
  }
  return { ok: true, items };
}

// ── Network call (shared retry/timeout) ─────────────────────────────────────

async function _postJson(url, body, timeoutMs, label) {
  logApiRequest(label, url, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const short = errBody.startsWith('<!') ? 'Cloudflare error' : errBody.substring(0, 500);
      throw new Error(`HTTP ${res.status}: ${short}`);
    }
    const data = await res.json();
    const duration = Date.now() - startTime;
    try { logApiResponse(label, url, data); } catch { /* best effort */ }
    log.info(`   ✅ ${label} reply in ${duration}ms`);
    return data;
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    const msg = isTimeout ? `Timeout (${timeoutMs / 1000}s)` : err.message;
    log.error(`   ❌ ${label} error: ${msg}`);
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a base64 payload from xAI's images/videos response.
 * The native shape is `{ data: [{ b64_json }] }`, but we tolerate `{ b64 }`
 * or `{ url }` (downloaded inline) as fallbacks.
 */
async function _extractBase64Payload(data) {
  if (!data || typeof data !== 'object') return null;
  const arr = Array.isArray(data.data) ? data.data : null;
  if (!arr || arr.length === 0) return null;
  const item = arr[0];
  if (!item || typeof item !== 'object') return null;
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) return item.b64_json;
  if (typeof item.b64 === 'string' && item.b64.length > 0) return item.b64;

  // Fallback: download a temporary URL inline. xAI URLs expire quickly so we
  // turn them into base64 right here.
  if (typeof item.url === 'string' && item.url.startsWith('http')) {
    try {
      const r = await fetch(item.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const arrBuf = await r.arrayBuffer();
      return Buffer.from(arrBuf).toString('base64');
    } catch (e) {
      log.warn(`Failed to download generated artefact from URL: ${e.message}`);
      return null;
    }
  }
  return null;
}

// ── generate_image ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images]
 * @param {string} [args.aspect_ratio]
 * @param {object} userCtx
 * @param {object} responseCtx
 */
async function generateImage(args, userCtx, responseCtx) {
  if (!HERMES_API_KEY) return { success: false, error: 'HERMES_API_KEY is not configured.' };
  if (!IMAGE_GEN_MODEL) return { success: false, error: 'IMAGE_GEN_MODEL is not configured.' };

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the image to generate.' };
  }

  // aspect_ratio: omit the field entirely when not specified so the proxy
  // uses its own default (some builds reject the literal string "auto").
  const aspect = (args && typeof args.aspect_ratio === 'string' && args.aspect_ratio.trim())
    ? args.aspect_ratio.trim()
    : null;
  if (aspect !== null && !ALLOWED_IMAGE_ASPECT_RATIOS.has(aspect)) {
    return {
      success: false,
      error: `Invalid aspect_ratio "${aspect}". Allowed: ${[...ALLOWED_IMAGE_ASPECT_RATIOS].join(', ')}.`,
    };
  }

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const refs = await _resolveReferenceImages(refList, MAX_REF_IMAGES_FOR_IMAGE, userCtx);
  if (!refs.ok) return { success: false, error: refs.reason };

  const body = {
    model: IMAGE_GEN_MODEL,
    prompt,
    n: 1,
    response_format: 'b64_json',
  };
  if (aspect !== null) {
    body.aspect_ratio = aspect;
  }
  if (refs.items.length > 0) {
    body.reference_images = refs.items.map(it => it.base64);
  }

  log.info(`🎨 generate_image: aspect=${aspect || 'omitted'}, refs=${refs.items.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let data;
  try {
    data = await _postJson(IMAGE_GEN_URL, body, IMAGE_REQUEST_TIMEOUT_MS, 'imagine/image');
  } catch (err) {
    await notifyAdmin('GenerateImage', `Image generation failed: ${err.message}`);
    return { success: false, error: `Image generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const b64 = await _extractBase64Payload(data);
  if (!b64) {
    await notifyAdmin('GenerateImage', 'Empty response from /images/generations');
    return { success: false, error: `Image generation returned an empty response.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); }
  catch {
    return { success: false, error: 'Image generation returned an invalid base64 payload.' };
  }
  if (buffer.length === 0) {
    return { success: false, error: 'Image generation returned an empty payload.' };
  }

  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || 'image';
  const filename = `${baseName}_${Date.now()}.png`;

  if (!Array.isArray(responseCtx.attachments)) responseCtx.attachments = [];
  responseCtx.attachments.push({
    name: filename,
    buffer,
    mimetype: 'image/png',
  });

  const refsNote = refs.items.length > 0
    ? ` Used ${refs.items.length} reference image(s): ${refs.items.map(r => r.displayPath).join(', ')}.`
    : '';
  const truncNote = truncated ? ' (prompt was truncated)' : '';

  return {
    success: true,
    message: `Image generated successfully and pushed to the delivery buffer.${refsNote}${truncNote}`,
  };
}

// ── generate_video ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images]
 * @param {string} [args.aspect_ratio]
 */
async function generateVideo(args, userCtx, responseCtx) {
  if (!HERMES_API_KEY) return { success: false, error: 'HERMES_API_KEY is not configured.' };
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

  const refList = Array.isArray(args && args.reference_images) ? args.reference_images : [];
  const refs = await _resolveReferenceImages(refList, MAX_REF_IMAGES_FOR_VIDEO, userCtx);
  if (!refs.ok) return { success: false, error: refs.reason };

  // Backend rules:
  //   - 0 references: text-to-video
  //   - 1 reference : image-to-video, sent as the singular `reference_image`
  //   - 2..7 refs   : reference-to-video, sent as `reference_images` array
  const body = {
    model: VIDEO_GEN_MODEL,
    prompt,
    duration: 10,
    aspect_ratio: aspect,
    resolution: '720p',
    response_format: 'b64_json',
  };
  if (refs.items.length === 1) {
    body.reference_image = refs.items[0].base64;
  } else if (refs.items.length > 1) {
    body.reference_images = refs.items.map(it => it.base64);
  }

  log.info(`🎬 generate_video: aspect=${aspect}, refs=${refs.items.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let data;
  try {
    data = await _postJson(VIDEO_GEN_URL, body, VIDEO_REQUEST_TIMEOUT_MS, 'imagine/video');
  } catch (err) {
    await notifyAdmin('GenerateVideo', `Video generation failed: ${err.message}`);
    return { success: false, error: `Video generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const b64 = await _extractBase64Payload(data);
  if (!b64) {
    await notifyAdmin('GenerateVideo', 'Empty response from /videos/generations');
    return { success: false, error: `Video generation returned an empty response.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); }
  catch {
    return { success: false, error: 'Video generation returned an invalid base64 payload.' };
  }
  if (buffer.length === 0) {
    return { success: false, error: 'Video generation returned an empty payload.' };
  }

  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || 'video';
  const filename = `${baseName}_${Date.now()}.mp4`;

  if (!Array.isArray(responseCtx.attachments)) responseCtx.attachments = [];
  responseCtx.attachments.push({
    name: filename,
    buffer,
    mimetype: 'video/mp4',
  });

  const refsNote = refs.items.length > 0
    ? ` Used ${refs.items.length} reference image(s): ${refs.items.map(r => r.displayPath).join(', ')}.`
    : '';
  const truncNote = truncated ? ' (prompt was truncated)' : '';

  return {
    success: true,
    message: `Video generated successfully (10s, 720p) and pushed to the delivery buffer.${refsNote}${truncNote}`,
  };
}

module.exports = { generateImage, generateVideo };
