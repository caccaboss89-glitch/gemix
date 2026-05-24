// src/tools/imagineGenerator.js
//
// Grok Imagine — generate images and short videos.
//
// Why we shell out to `hermes -z` instead of hitting an HTTP endpoint:
//
// Hermes Agent v0.14's OpenAI-compatible proxy only forwards five paths to
// xAI: /chat/completions, /completions, /embeddings, /models, /responses.
// None of them accepts Imagine — the dedicated /images/generations and
// /videos/generations endpoints return 404 ("Path not forwarded"), and
// /responses only accepts these tool variants (verbatim from the proxy):
//   function, web_search, x_search, collections_search, file_search,
//   code_execution, code_interpreter, mcp, shell
//
// Hermes itself, however, ships internal toolsets `image_gen` and
// `video_gen` (configured for `grok-imagine-image-quality` /
// `grok-imagine-video`) that DO produce media — but only through the
// CLI / TUI, not the proxy. The one-shot mode (`hermes -z "<prompt>"`)
// invokes those tools and prints exactly the URL of the generated media
// on stdout, which is the contract we need.
//
// The shell wrapper at bridge/imagine.sh is the one that actually runs the
// CLI and parses the URL. This file spawns the wrapper (no shell, no
// injection) and turns the URL into a buffered attachment.
//
// Limitations of the bridge (vs the original Step 7 design):
//   - reference_images: not supported by hermes -z (the CLI can't ingest
//     binary inputs into the image_gen / video_gen toolsets). If the model
//     passes them, we return a clear structured error so it can retry
//     without them.

const path = require('path');
const { spawn } = require('child_process');
const {
  HERMES_API_KEY,
  IMAGE_GEN_MODEL,
  VIDEO_GEN_MODEL,
} = require('../config/env');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');

const log = createLogger('ImagineGenerator');

// Absolute path to the wrapper. We invoke it via `bash` so the executable
// bit on the script is irrelevant (some deployments end up without +x).
const BRIDGE_SCRIPT = path.resolve(__dirname, '..', '..', 'bridge', 'imagine.sh');

// ── Limits ──────────────────────────────────────────────────────────────────

// hermes -z for an image typically takes 15-40 s. For video, 30-180 s.
// Keep a generous ceiling on top of that.
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_TIMEOUT_MS = 8 * 60 * 1000;

// Cap on the prompt to keep CLI argv reasonable.
const MAX_PROMPT_LEN = 2000;

const ALLOWED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4']);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16']);

// ── Helpers ─────────────────────────────────────────────────────────────────

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
 * Spawn `bash bridge/imagine.sh <args>` and collect stdout/stderr.
 * Returns { code, stdout, stderr } on completion, throws on timeout / spawn error.
 *
 * No shell is used (only `bash` as the script interpreter, with the script
 * path and arguments passed positionally) — prompts and ratios cannot be
 * misinterpreted as shell metacharacters.
 */
function _runBridge(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [BRIDGE_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Bridge spawn failed: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`Bridge timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Pull the first https URL out of the bridge's stdout. The bridge already
 * reduces stdout to one line, but we still verify it's a clean URL so we
 * never feed garbage to fetch().
 */
function _extractUrl(stdout) {
  if (typeof stdout !== 'string') return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/);
  if (!match) return null;
  // Strip a few trailing punctuation chars that occasionally appear if
  // the model added a stray period etc.
  return match[0].replace(/[.,)\]\}\">]+$/, '');
}

/**
 * Download a URL into a Buffer. Used for the URL emitted by hermes -z
 * (xAI temporary URLs expire fast — we materialize the bytes immediately).
 */
async function _downloadToBuffer(url) {
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

// ── generate_image ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images]   Currently unsupported by the bridge.
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
  if (refList.length > 0) {
    return {
      success: false,
      error: 'reference_images are not supported by the current Hermes bridge. '
        + 'Retry without reference_images, describing the desired look in the prompt instead.',
    };
  }

  const cliArgs = ['image', prompt];
  if (aspect !== null) cliArgs.push(aspect);

  log.info(`🎨 generate_image: aspect=${aspect || 'omitted'}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let result;
  try {
    result = await _runBridge(cliArgs, IMAGE_TIMEOUT_MS);
  } catch (err) {
    await notifyAdmin('GenerateImage', err.message);
    return { success: false, error: `Image generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout || '').slice(-500).trim();
    log.error(`   ❌ imagine/image bridge exit ${result.code}: ${tail}`);
    await notifyAdmin('GenerateImage', `Bridge exit ${result.code}: ${tail}`);
    return {
      success: false,
      error: `Image generation failed (bridge exit ${result.code}).${ADMIN_NOTIFIED_SUFFIX}`,
    };
  }

  const url = _extractUrl(result.stdout);
  if (!url) {
    await notifyAdmin('GenerateImage', `Bridge returned no URL. stdout="${result.stdout.slice(0, 300)}"`);
    return { success: false, error: `Image generation produced no URL.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try {
    buffer = await _downloadToBuffer(url);
  } catch (err) {
    await notifyAdmin('GenerateImage', `Download from ${url} failed: ${err.message}`);
    return { success: false, error: `Image download failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || 'image';
  // hermes -z most often emits .jpeg URLs; preserve extension when present.
  const urlExt = (url.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i) || [])[1] || 'png';
  const filename = `${baseName}_${Date.now()}.${urlExt.toLowerCase()}`;
  const mimetype = urlExt.toLowerCase() === 'png' ? 'image/png'
    : urlExt.toLowerCase().startsWith('jp') ? 'image/jpeg'
      : urlExt.toLowerCase() === 'webp' ? 'image/webp'
        : urlExt.toLowerCase() === 'gif' ? 'image/gif'
          : 'application/octet-stream';

  if (!Array.isArray(responseCtx.attachments)) responseCtx.attachments = [];
  responseCtx.attachments.push({ name: filename, buffer, mimetype });

  const truncNote = truncated ? ' (prompt was truncated)' : '';
  return {
    success: true,
    message: `Image generated successfully and pushed to the delivery buffer.${truncNote}`,
  };
}

// ── generate_video ──────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.reference_images]   Currently unsupported by the bridge.
 * @param {string} [args.aspect_ratio]
 * @param {object} userCtx
 * @param {object} responseCtx
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
  if (refList.length > 0) {
    return {
      success: false,
      error: 'reference_images are not supported by the current Hermes bridge. '
        + 'Retry without reference_images, describing the desired look / characters / framing in the prompt instead.',
    };
  }

  // Fixed knobs (matches the original Step 7 contract): 10 seconds, 720p.
  const cliArgs = ['video', prompt, aspect, '10', '720p'];

  log.info(`🎬 generate_video: aspect=${aspect}, prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}"`);

  let result;
  try {
    result = await _runBridge(cliArgs, VIDEO_TIMEOUT_MS);
  } catch (err) {
    await notifyAdmin('GenerateVideo', err.message);
    return { success: false, error: `Video generation failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout || '').slice(-500).trim();
    log.error(`   ❌ imagine/video bridge exit ${result.code}: ${tail}`);
    await notifyAdmin('GenerateVideo', `Bridge exit ${result.code}: ${tail}`);
    return {
      success: false,
      error: `Video generation failed (bridge exit ${result.code}).${ADMIN_NOTIFIED_SUFFIX}`,
    };
  }

  const url = _extractUrl(result.stdout);
  if (!url) {
    await notifyAdmin('GenerateVideo', `Bridge returned no URL. stdout="${result.stdout.slice(0, 300)}"`);
    return { success: false, error: `Video generation produced no URL.${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let buffer;
  try {
    buffer = await _downloadToBuffer(url);
  } catch (err) {
    await notifyAdmin('GenerateVideo', `Download from ${url} failed: ${err.message}`);
    return { success: false, error: `Video download failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  const baseName = sanitizeFilename(prompt.slice(0, 30), 30) || 'video';
  const urlExt = (url.match(/\.(mp4|webm|mov)(?:\?|$)/i) || [])[1] || 'mp4';
  const filename = `${baseName}_${Date.now()}.${urlExt.toLowerCase()}`;
  const mimetype = urlExt.toLowerCase() === 'webm' ? 'video/webm'
    : urlExt.toLowerCase() === 'mov' ? 'video/quicktime'
      : 'video/mp4';

  if (!Array.isArray(responseCtx.attachments)) responseCtx.attachments = [];
  responseCtx.attachments.push({ name: filename, buffer, mimetype });

  const truncNote = truncated ? ' (prompt was truncated)' : '';
  return {
    success: true,
    message: `Video generated successfully (10s, 720p) and pushed to the delivery buffer.${truncNote}`,
  };
}

module.exports = { generateImage, generateVideo };
