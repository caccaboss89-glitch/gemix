// src/tools/imagineGenerator.js
//
// Grok Imagine — generate images and short videos via the Hermes proxy.
//
// Hermes Agent v0.14 only forwards a handful of paths to xAI:
//   /chat/completions, /completions, /embeddings, /models, /responses
// The dedicated /images/generations and /videos/generations endpoints are NOT
// proxied. Imagine is therefore consumed as server-side tools inside
// POST {HERMES_BASE_URL}/responses, exactly like webXSearch and
// codeInterpreter do for web_search / x_search / code_interpreter.
//
// Tool names sent in the body:
//   - generate_image  → tools: [{ type: 'image_generation' }]
//   - generate_video  → tools: [{ type: 'video_generation' }]
//
// Reference images are still resolved through the same path rules used by
// read_file (chat history, /readonly/searched_images, /workspace/...). They
// are read from disk, validated, and forwarded as base64 in the request
// body. We never accept URLs or arbitrary buffers — the AI can only
// reference files it could already read.

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
const { isPathAllowed, ensureUserSkeleton } = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');

const log = createLogger('ImagineGenerator');

// ── Endpoint (single, shared) ───────────────────────────────────────────────

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

// xAI Imagine tool type names inside /responses.
const IMAGE_TOOL_TYPE = 'image_generate';
const VIDEO_TOOL_TYPE = 'video_generate';

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
  if (typeof prompt !== 'string') return { prompt: '', truncated: false };
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

// ── Network call (shared) ───────────────────────────────────────────────────

async function _callResponses(body, timeoutMs, label) {
  logApiRequest(label, RESPONSES_URL, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();
  try {
    const res = await fetch(RESPONSES_URL, {
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
    try { logApiResponse(label, RESPONSES_URL, data); } catch { /* best effort */ }
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
 * Walk the /responses payload looking for any embedded base64 media.
 *
 * The Responses API can place generated artefacts in several spots, depending
 * on the proxy build and on whether the underlying endpoint shape is the
 * "openai-style" one (`{ data: [{ b64_json }] }`) or the "responses-style"
 * one (`{ output: [{ content: [{ type: 'image'|'output_image'|'video', ... }] }] }`).
 *
 * We try every plausible location and fall back to downloading a temporary
 * URL inline if that's the only thing we get.
 *
 * @param {object} data
 * @returns {Promise<string|null>} base64 string or null
 */
async function _extractBase64Payload(data) {
  if (!data || typeof data !== 'object') return null;

  const urlsToTry = [];

  const visit = (node, depth = 0) => {
    if (!node || depth > 8) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof node !== 'object') return null;

    // Common base64 fields, in order of likelihood.
    const candidates = [
      node.b64_json,
      node.b64,
      node.image_base64,
      node.video_base64,
      node.base64,
      // Some shapes nest the bytes under image / video objects.
      node.image && (node.image.b64_json || node.image.b64 || node.image.base64),
      node.video && (node.video.b64_json || node.video.b64 || node.video.base64),
      // Responses API tool results: `{ type: 'output_image', image: { ... } }` or
      // `{ type: 'image', source: { data: '...' } }`.
      node.source && (node.source.data || node.source.b64_json),
      node.data && typeof node.data === 'string' ? node.data : null,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length >= 64 && /^[A-Za-z0-9+/=\s]+$/.test(c)) {
        return c.replace(/\s+/g, '');
      }
    }

    // Collect URLs as a last-resort fallback.
    if (typeof node.url === 'string' && node.url.startsWith('http')) {
      urlsToTry.push(node.url);
    }
    if (node.image && typeof node.image.url === 'string' && node.image.url.startsWith('http')) {
      urlsToTry.push(node.image.url);
    }
    if (node.video && typeof node.video.url === 'string' && node.video.url.startsWith('http')) {
      urlsToTry.push(node.video.url);
    }

    // Recurse into known container fields plus any nested object/array.
    const containers = ['data', 'output', 'content', 'results', 'items', 'parts', 'attachments', 'tool_results', 'tool_outputs'];
    for (const key of containers) {
      if (key in node) {
        const found = visit(node[key], depth + 1);
        if (found) return found;
      }
    }

    // Generic fallback: walk every value once.
    for (const key of Object.keys(node)) {
      if (containers.includes(key)) continue;
      const v = node[key];
      if (v && typeof v === 'object') {
        const found = visit(v, depth + 1);
        if (found) return found;
      }
    }

    return null;
  };

  const direct = visit(data);
  if (direct) return direct;

  // Last resort: download the first reachable URL.
  for (const url of urlsToTry) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const arrBuf = await r.arrayBuffer();
      return Buffer.from(arrBuf).toString('base64');
    } catch (e) {
      log.warn(`Failed to download generated artefact from URL (${url}): ${e.message}`);
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
  // uses its own default.
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

  // Build the user content. The prompt always goes in as text. Reference
  // images, if any, are attached as data URLs alongside it — the same OpenAI
  // multimodal shape we already use for chat completions, which xAI's
  // image_generation tool understands.
  const userContent = [{ type: 'input_text', text: prompt }];
  for (const ref of refs.items) {
    userContent.push({
      type: 'input_image',
      image_url: `data:${ref.mime};base64,${ref.base64}`,
    });
  }

  // The `image_generation` tool descriptor carries the image-shaping params.
  // Only include aspect_ratio when explicitly requested.
  const imageTool = { type: IMAGE_TOOL_TYPE };
  if (aspect !== null) imageTool.aspect_ratio = aspect;

  const body = {
    model: IMAGE_GEN_MODEL,
    input: [{ role: 'user', content: userContent }],
    tools: [imageTool],
  };

  log.info(`🎨 generate_image: aspect=${aspect || 'omitted'}, refs=${refs.items.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let data;
  try {
    data = await _callResponses(body, IMAGE_REQUEST_TIMEOUT_MS, 'imagine/image');
  } catch (err) {
    await notifyAdmin('GenerateImage', `Image generation failed: ${err.message}`);
    return { success: false, error: `Image generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const b64 = await _extractBase64Payload(data);
  if (!b64) {
    await notifyAdmin('GenerateImage', 'Empty response from /responses (image_generation tool)');
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

  // Build the user content (prompt + optional reference images as data URLs).
  const userContent = [{ type: 'input_text', text: prompt }];
  for (const ref of refs.items) {
    userContent.push({
      type: 'input_image',
      image_url: `data:${ref.mime};base64,${ref.base64}`,
    });
  }

  // video_generation tool descriptor carries the video-shaping params.
  // Backend rules (handled server-side by xAI):
  //   - 0 references: text-to-video
  //   - 1 reference : image-to-video
  //   - 2..7 refs   : reference-to-video
  const videoTool = {
    type: VIDEO_TOOL_TYPE,
    duration: 10,
    aspect_ratio: aspect,
    resolution: '720p',
  };

  const body = {
    model: VIDEO_GEN_MODEL,
    input: [{ role: 'user', content: userContent }],
    tools: [videoTool],
  };

  log.info(`🎬 generate_video: aspect=${aspect}, refs=${refs.items.length}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let data;
  try {
    data = await _callResponses(body, VIDEO_REQUEST_TIMEOUT_MS, 'imagine/video');
  } catch (err) {
    await notifyAdmin('GenerateVideo', `Video generation failed: ${err.message}`);
    return { success: false, error: `Video generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const b64 = await _extractBase64Payload(data);
  if (!b64) {
    await notifyAdmin('GenerateVideo', 'Empty response from /responses (video_generation tool)');
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
