// src/tools/openaiImageGenerator.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// The `generate_image` adapter for the OpenAI profile.
//
// One logical tool, two back ends: gpt-image-2 on the Codex backend, and a
// single Cloudflare FLUX attempt when — and only when — the primary failed in a
// way a retry elsewhere could actually fix. Both return base64, never a URL, so
// the artifact is decoded, checked against its own magic bytes, written
// atomically and pushed to the delivery buffer here.
//
// Nothing on this path touches xAI: no upload, no /files, no stale-URL refresh,
// and no suggestion to hand the result to a video tool that does not exist on
// this profile. Editing, reference images and aspect ratio were never validated
// on gpt-image-2, so a call carrying them is refused rather than silently
// downgraded to text-to-image.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import envConfig from '../config/env.js';
import { getOpenAiAuth } from '../config/openaiAuth.js';
import { joinUrl } from '../ai/openaiResponsesProtocol.js';
import { OPENAI_ERROR, classifyHttpFailure, summarizeErrorBody } from '../ai/openaiResponsesTransport.js';
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
const FALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_PROMPT_LEN = 2000;
/** Bigger than any single generated still; the decode stops before this. */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
/** Resolution the fallback is asked for, and what its neuron charge is based on. */
const FALLBACK_SIZE = 512;

/** Fields gpt-image-2 was never probed with; accepting them would be a promise. */
const UNVALIDATED_FIELDS = ['reference_images', 'image', 'images', 'mask', 'aspect_ratio', 'size', 'quality'];

/** Primary failures where a second back end is worth trying. */
const FALLBACK_WORTHY = new Set([
  OPENAI_ERROR.RATE_LIMIT,
  OPENAI_ERROR.SUBSCRIPTION_LIMIT,
  OPENAI_ERROR.TRANSIENT,
  OPENAI_ERROR.TIMEOUT,
  OPENAI_ERROR.MALFORMED_RESPONSE
]);

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
 * gpt-image-2 on the Codex backend.
 * @param {string} prompt
 * @returns {Promise<{ ok: true, b64: string, meta: object } | { ok: false, kind: string, detail: string }>}
 */
async function _generateWithCodex(prompt) {
  let auth;
  try {
    auth = getOpenAiAuth();
  } catch (err) {
    return { ok: false, kind: OPENAI_ERROR.AUTH, detail: err.code || err.message };
  }

  const url = joinUrl(envConfig.OPENAI_BASE_URL, 'images/generations');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-ID': auth.chatgptAccountId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: envConfig.OPENAI_IMAGE_MODEL,
        prompt,
        n: 1
      }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      kind: timedOut ? OPENAI_ERROR.TIMEOUT : OPENAI_ERROR.TRANSIENT,
      detail: timedOut ? `no response within ${IMAGE_TIMEOUT_MS} ms` : err.message
    };
  }

  const bodyText = await res.text();
  if (!res.ok) {
    return { ok: false, kind: classifyHttpFailure(res.status, bodyText), detail: summarizeErrorBody(bodyText) };
  }

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, kind: OPENAI_ERROR.MALFORMED_RESPONSE, detail: 'the response was not JSON' };
  }

  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!item || typeof item.b64_json !== 'string') {
    return { ok: false, kind: OPENAI_ERROR.MALFORMED_RESPONSE, detail: 'the response carried no b64_json entry' };
  }
  // The backend normalizes size and quality, so what it actually produced is
  // read back from the response rather than assumed from the request.
  return {
    ok: true,
    b64: item.b64_json,
    meta: { size: payload.size || item.size || null, quality: payload.quality || item.quality || null }
  };
}

/**
 * The single Cloudflare FLUX attempt. Charged on the shared neuron ledger
 * before the request goes out; refunded only when the request provably never
 * reached Cloudflare.
 *
 * @param {string} prompt
 * @returns {Promise<{ ok: true, b64: string } | { ok: false, detail: string }>}
 */
async function _generateWithFlux(prompt) {
  if (!envConfig.CLOUDFLARE_AI_ACCOUNT_ID || !envConfig.CLOUDFLARE_AI_API_TOKEN) {
    return { ok: false, detail: 'the fallback back end is not configured' };
  }

  const cost = neuronsForImage(FALLBACK_SIZE, FALLBACK_SIZE);
  const reservation = await reserveNeurons(cost, 'image');
  if (!reservation.ok) {
    return { ok: false, detail: IMAGE_DAILY_LIMIT_MESSAGE, quotaExhausted: true };
  }

  const url = `${CLOUDFLARE_API_BASE}/${envConfig.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${envConfig.CLOUDFLARE_IMAGE_MODEL}`;
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('width', String(FALLBACK_SIZE));
  form.set('height', String(FALLBACK_SIZE));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${envConfig.CLOUDFLARE_AI_API_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS)
    });
  } catch (err) {
    // A failed fetch can still have reached Cloudflare. Keep the pessimistic
    // charge so retrying the fallback cannot overshoot the shared allowance.
    return { ok: false, detail: err.name === 'TimeoutError' ? 'the fallback timed out' : err.message };
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
    return { ok: false, detail: 'the fallback returned no image' };
  }
  return { ok: true, b64 };
}

/**
 * `generate_image` on the OpenAI profile.
 *
 * @param {object} args
 * @param {string} args.prompt
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
  if (!envConfig.OPENAI_IMAGE_MODEL) {
    return { success: false, error: 'envConfig.OPENAI_IMAGE_MODEL is not configured.' };
  }

  const offered = UNVALIDATED_FIELDS.filter(field => args && args[field] !== undefined);
  if (offered.length > 0) {
    return {
      success: false,
      error: `This image generator takes a prompt only: ${offered.join(', ')} ${offered.length === 1 ? 'is' : 'are'} not supported. `
        + 'Describe what you want in the prompt instead.'
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
    let usedFallback = false;
    let meta = {};
    const attempt = await _generateWithCodex(prompt);
    let decoded = attempt.ok ? decodeImageBase64(attempt.b64) : null;
    if (decoded?.ok) meta = attempt.meta || {};

    // The primary can let us down two ways: it refuses, or it answers with bytes
    // that are not an image. Both earn one FLUX attempt — a result that does not
    // decode is no more usable than no result at all.
    if (!decoded?.ok) {
      const why = attempt.ok
        ? `unusable result: ${decoded.reason}`
        : `${attempt.kind}: ${attempt.detail}`;
      log.warn(`${envConfig.OPENAI_IMAGE_MODEL} failed (${why})`);
      if (!attempt.ok && !FALLBACK_WORTHY.has(attempt.kind)) {
        return { success: false, error: `Image generation failed: ${attempt.detail}` };
      }
      const fallback = await _generateWithFlux(prompt);
      if (!fallback.ok) {
        return {
          success: false,
          error: `Image generation failed: ${why}. The fallback did not run either: ${fallback.detail}.`
        };
      }
      decoded = decodeImageBase64(fallback.b64);
      if (!decoded.ok) {
        return { success: false, error: `Image generation produced an unusable result: ${decoded.reason}.` };
      }
      usedFallback = true;
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

    const notes = [];
    if (truncated) notes.push('the prompt was truncated');
    if (usedFallback) notes.push('the primary generator was unavailable, so a fallback produced this one');
    if (meta.size) notes.push(`size ${meta.size}`);
    const suffix = notes.length > 0 ? ` (${notes.join('; ')})` : '';

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
  UNVALIDATED_FIELDS,
  FALLBACK_WORTHY,
  decodeImageBase64,
  generateImageOpenAi
};
