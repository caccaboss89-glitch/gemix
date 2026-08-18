// src/tools/openaiImageGenerator.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// The `generate_image` adapter for the OpenAI profile.
//
// Images come from Cloudflare Workers AI (FLUX), never from the ChatGPT
// backend: that route needs an API scope this deployment's OAuth credential
// does not carry. The response is base64, never a URL, so the artifact is
// decoded, checked against its own magic bytes, written atomically and pushed
// to the delivery buffer here.
//
// Text-to-image only. The endpoint was probed with an input image under every
// plausible field name, as a file part and as base64, and ignored all of them:
// the output came back at the default size, byte-for-byte as unrelated as the
// control field that certainly does not exist. So there is no editing and no
// reference image to offer, and a call carrying one is refused rather than
// silently downgraded. Width and height ARE honoured, which is what makes
// aspect_ratio real.
//
// Nothing on this path touches xAI: no upload, no /files, no stale-URL refresh,
// and no suggestion to hand the result to a video tool that does not exist on
// this profile.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import envConfig from '../config/env.js';
import { profileFromContext } from '../ai/providers/providerProfile.js';
import { mimeForExtension } from '../config/mimeExtensions.js';
import { pushBufferAttachment } from '../utils/attachments.js';
import { projectToolResult } from '../utils/aiFileDelivery.js';
import { sniffImageType } from '../utils/imageRegistry.js';
import { reserveGeneration } from '../utils/mediaUsageLimits.js';
import {
  neuronsForImage,
  reserveNeurons,
  openQuotaCircuit,
  IMAGE_DAILY_LIMIT_MESSAGE
} from '../utils/cloudflareNeurons.js';
import { resolveStorageId } from '../utils/userPaths.js';
import { tempDirForOwner } from '../utils/tempFileServer.js';
import { sanitizeFilename } from '../utils/text.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OpenAiImageGen');

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_PROMPT_LEN = 2000;
/** Bigger than any single generated still; the decode stops before this. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Pixel sizes per aspect ratio. The endpoint honours width and height as given,
 * so these are the real output dimensions; they stay modest because every tile
 * is charged against the shared daily neuron allowance.
 */
const ASPECT_SIZES = Object.freeze({
  '1:1': [1024, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '4:3': [1152, 864],
  '3:4': [864, 1152]
});
const DEFAULT_ASPECT = '1:1';

/**
 * Fields the model might reach for out of habit from the other profile. The
 * endpoint ignores an input image entirely, so accepting any of these would
 * quietly produce something unrelated to what was asked.
 */
const UNSUPPORTED_FIELDS = ['reference_images', 'image', 'images', 'mask', 'quality', 'size'];

/** The image types the artifact check accepts, keyed by their real MIME. */
const ACCEPTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Sanitize the prompt: strip control chars, collapse whitespace, cap length.
 * @param {unknown} prompt
 * @returns {{ prompt: string, truncated: boolean }}
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
 * Decode a base64 image, bounded and strict.
 *
 * The length is checked before the decode so a hostile or corrupt payload
 * cannot be materialized first and rejected after, and the bytes have to
 * identify themselves: a body that does not start with a real PNG/JPEG/WEBP
 * signature is not an image whatever the response called it.
 *
 * @param {unknown} b64
 * @returns {{ ok: true, buffer: Buffer, ext: string, mime: string } | { ok: false, reason: string }}
 */
function decodeImageBase64(b64) {
  if (typeof b64 !== 'string' || !b64.trim()) return { ok: false, reason: 'the response carried no image data' };
  const clean = b64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return { ok: false, reason: 'the image data is not valid base64' };
  // 4 base64 characters carry 3 bytes; refuse before allocating anything.
  if (Math.floor(clean.length / 4) * 3 > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `the image exceeds the ${MAX_IMAGE_BYTES}-byte limit` };
  }

  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length === 0) return { ok: false, reason: 'the image data decoded to nothing' };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `the image exceeds the ${MAX_IMAGE_BYTES}-byte limit` };
  }

  const sniffed = sniffImageType(buffer);
  if (!sniffed || !ACCEPTED_IMAGE_MIMES.has(sniffed.mime)) {
    return { ok: false, reason: 'the decoded body is not a PNG, JPEG or WEBP image' };
  }
  return { ok: true, buffer, ext: sniffed.ext, mime: sniffed.mime };
}

/**
 * Write the artifact where a delivery failure can still find it, then hand it
 * to the buffer. The write goes to a temporary name and is renamed into place,
 * so a crash mid-write cannot leave a half file under the final name.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string|null} ownerKey
 * @returns {string} absolute path of the stored artifact
 */
function _persistArtifact(buffer, filename, ownerKey) {
  const dir = tempDirForOwner(ownerKey);
  const finalPath = path.join(dir, filename);
  const stagingPath = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.part`;
  fs.writeFileSync(stagingPath, buffer);
  fs.renameSync(stagingPath, finalPath);
  return finalPath;
}

/** Name for the artifact: derived from the prompt, never from model-supplied text. */
function _artifactName(prompt, ext) {
  const base = sanitizeFilename(prompt.slice(0, 30), 30) || 'image';
  return `${base}_${Date.now()}${ext}`;
}

/**
 * The per-turn record of what each tool call already produced. A replayed or
 * retried `call_id` gets the same artifact back instead of generating,
 * charging and delivering a second one.
 */
function _ledgerFor(responseCtx) {
  if (!responseCtx || typeof responseCtx !== 'object') return null;
  if (!responseCtx.imageCallLedger) responseCtx.imageCallLedger = new Map();
  return responseCtx.imageCallLedger;
}

/**
 * Ask Cloudflare Workers AI for one image.
 *
 * Charged on the shared neuron ledger before the request goes out and refunded
 * only when the request provably never reached Cloudflare, so a retry cannot
 * overshoot the daily allowance.
 *
 * The endpoint takes multipart only — a JSON body is rejected outright — and
 * answers `{ success, result: { image: <base64 JPEG> } }`.
 *
 * @param {string} prompt
 * @param {[number, number]} size - [width, height] in pixels
 * @returns {Promise<{ ok: true, b64: string } | { ok: false, detail: string, quotaExhausted?: boolean }>}
 */
async function _generateWithCloudflare(prompt, [width, height]) {
  if (!envConfig.CLOUDFLARE_AI_ACCOUNT_ID || !envConfig.CLOUDFLARE_AI_API_TOKEN) {
    return { ok: false, detail: 'the image back end is not configured' };
  }

  const reservation = await reserveNeurons(neuronsForImage(width, height), 'image');
  if (!reservation.ok) {
    return { ok: false, detail: IMAGE_DAILY_LIMIT_MESSAGE, quotaExhausted: true };
  }

  const url = `${CLOUDFLARE_API_BASE}/${envConfig.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${envConfig.CLOUDFLARE_IMAGE_MODEL}`;
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('width', String(width));
  form.set('height', String(height));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${envConfig.CLOUDFLARE_AI_API_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    });
  } catch (err) {
    // A failed fetch can still have reached Cloudflare. Keep the pessimistic
    // charge rather than refunding work that may well have been done.
    return { ok: false, detail: err.name === 'TimeoutError' ? 'the request timed out' : err.message };
  }

  const bodyText = await res.text();
  let payload = null;
  try { payload = JSON.parse(bodyText); } catch { /* reported below */ }

  if (!res.ok || payload?.success === false) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join('; ')
      : bodyText.slice(0, 200);
    if (res.status === 429 || /quota|neuron|exceeded|limit/i.test(detail)) {
      await openQuotaCircuit();
      return { ok: false, detail: IMAGE_DAILY_LIMIT_MESSAGE, quotaExhausted: true };
    }
    return { ok: false, detail };
  }

  const b64 = payload?.result?.image;
  if (typeof b64 !== 'string' || !b64) {
    return { ok: false, detail: 'the back end returned no image' };
  }
  return { ok: true, b64 };
}

/**
 * `generate_image` on the OpenAI profile.
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {string} [args.aspect_ratio] - one of ASPECT_SIZES; square when omitted
 * @param {object} userCtx
 * @param {object} responseCtx
 * @param {string} [callId] - the tool call this run belongs to (idempotency key)
 * @returns {Promise<object|Array>}
 */
async function generateImageOpenAi(args, userCtx, responseCtx, callId = null) {
  const profile = profileFromContext(userCtx);
  if (!profile.capabilities.generateImage) {
    return { success: false, error: 'Image generation is not available on this GemiX deployment.' };
  }
  if (!envConfig.CLOUDFLARE_IMAGE_MODEL) {
    return { success: false, error: 'envConfig.CLOUDFLARE_IMAGE_MODEL is not configured.' };
  }

  const offered = UNSUPPORTED_FIELDS.filter(field => args && args[field] !== undefined);
  if (offered.length > 0) {
    return {
      success: false,
      error: `This image generator takes a prompt and an aspect ratio only: ${offered.join(', ')} `
        + `${offered.length === 1 ? 'is' : 'are'} not supported. It cannot edit an image or use one as reference — `
        + 'describe everything you want in the prompt instead.'
    };
  }

  const aspect = args?.aspect_ratio === undefined ? DEFAULT_ASPECT : args.aspect_ratio;
  if (!Object.hasOwn(ASPECT_SIZES, aspect)) {
    return {
      success: false,
      error: `Unsupported "aspect_ratio": ${JSON.stringify(args.aspect_ratio)}. `
        + `Use one of: ${Object.keys(ASPECT_SIZES).join(', ')}.`
    };
  }

  const { prompt, truncated } = _cleanPrompt(args && args.prompt);
  if (!prompt || prompt.length < 3) {
    return { success: false, error: 'Missing or too short "prompt": describe the image to generate.' };
  }

  const storageId = resolveStorageId(userCtx);
  if (!storageId) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }

  // A replayed call_id returns what it produced the first time: one generation,
  // one quota unit, one file, one delivery.
  const ledger = _ledgerFor(responseCtx);
  if (callId && ledger && ledger.has(callId)) {
    log.info(`call ${callId} already produced an image; replaying its result`);
    return ledger.get(callId);
  }

  log.info(`generate_image: prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // Reserved before the network call so parallel calls in one round cannot
  // exceed the cap, and committed only once a valid artifact exists.
  const quota = await reserveGeneration('image', userCtx);
  if (!quota.ok) return { success: false, error: quota.error };

  try {
    const size = ASPECT_SIZES[aspect];
    const attempt = await _generateWithCloudflare(prompt, size);
    if (!attempt.ok) {
      log.warn(`${envConfig.CLOUDFLARE_IMAGE_MODEL} failed: ${attempt.detail}`);
      return {
        success: false,
        error: attempt.quotaExhausted ? attempt.detail : `Image generation failed: ${attempt.detail}.`
      };
    }

    const decoded = decodeImageBase64(attempt.b64);
    if (!decoded.ok) {
      return { success: false, error: `Image generation produced an unusable result: ${decoded.reason}.` };
    }

    const filename = _artifactName(prompt, decoded.ext);
    let absPath;
    try {
      absPath = _persistArtifact(decoded.buffer, filename, storageId);
    } catch (err) {
      return { success: false, error: `Image could not be stored: ${err.message}.` };
    }

    // The artifact is valid and on disk: from here the quota is spent and the
    // file is the user's, whatever the platform does with it next.
    const storedName = pushBufferAttachment(responseCtx, {
      name: filename,
      buffer: decoded.buffer,
      filePath: absPath,
      mimetype: mimeForExtension(decoded.ext)
    });
    quota.commit();

    const notes = [`${size[0]}x${size[1]}`];
    if (truncated) notes.push('the prompt was truncated');
    const suffix = ` (${notes.join('; ')})`;

    const result = await projectToolResult({
      payload: (attached) => ({
        success: true,
        filename: storedName,
        message: `Image generated and pushed to the delivery buffer as "${storedName}"${suffix}. `
          + 'Put that filename in final `attachments` to send it.'
          + (attached > 0 ? ' Attached below so you can see it.' : '')
      }),
      previews: [{ buffer: decoded.buffer, filename: storedName, mimetype: mimeForExtension(decoded.ext) }]
    }, { providerProfile: profile });

    if (callId && ledger) ledger.set(callId, result);
    return result;
  } finally {
    await quota.release();
  }
}

export {
  MAX_IMAGE_BYTES,
  ASPECT_SIZES,
  UNSUPPORTED_FIELDS,
  decodeImageBase64,
  generateImageOpenAi
};
