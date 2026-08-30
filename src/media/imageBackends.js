// src/media/imageBackends.js
//
// The image-generation backends and the rules for moving between them.
//
// Two backends exist and they are not interchangeable, which is why the tool
// schema is built per backend rather than shared:
//
//   xai-imagine-image  up to 3 references, real edit/compose, aspect ratios
//   cloudflare-flux    one reference, multipart only, and the result is a free
//                      regeneration guided by the reference — not a faithful
//                      edit. Sizes are pixel dimensions, not ratios.
//
// Telling the model an aspect ratio enum it cannot honour, or promising an edit
// that will come back as a different picture, is worse than exposing the
// smaller schema honestly.
//
// The generic baseline is Cloudflare. The xAI profile alone replaces it with
// xAI as primary and may fall back to Cloudflare for compatible text-only
// requests. A content-policy refusal is never retried elsewhere: routing
// around a provider's safety decision is not a fallback.

import { CF_ERROR, callWorkersAi, isCloudflareConfigured } from './cloudflareClient.js';
import envConfig from '../config/env.js';
import { FEATURE, backendFor, fallbackBackendFor } from '../features/featureBindings.js';
import { resolveProviderProfile } from '../ai/providers/providerProfile.js';
import { createLogger } from '../utils/logger.js';
import { sniffImageType } from '../utils/imageType.js';

const log = createLogger('ImageBackends');

const BACKEND = Object.freeze({
  XAI: 'xai-imagine-image',
  CLOUDFLARE: 'cloudflare-flux'
});

/**
 * Sizes FLUX actually serves, as width x height. The model picks by name; the
 * ratio enum the xAI variant uses does not exist here, because klein-4b takes
 * pixel dimensions and only some of them come back at full quality.
 */
const FLUX_SIZES = Object.freeze({
  square: { width: 1024, height: 1024 },
  landscape: { width: 1280, height: 768 },
  portrait: { width: 768, height: 1280 },
  wide: { width: 1536, height: 640 }
});

const FLUX_DEFAULT_SIZE = 'square';

/** FLUX takes exactly one reference; more are not composed, they are ignored. */
const FLUX_MAX_REFERENCES = 1;

/** Closest FLUX output shape for each aspect ratio exposed by xAI. */
const XAI_ASPECT_TO_FLUX_SIZE = Object.freeze({
  '1:1': 'square',
  '16:9': 'landscape',
  '9:16': 'portrait',
  '4:3': 'landscape',
  '3:4': 'portrait'
});

/**
 * How long a primary backend stays skipped after it rate-limited us.
 * Long enough that a burst does not keep probing it, short enough that a
 * transient limit does not exile the better backend for the rest of the day.
 */
const COOLDOWN_MS = 10 * 60 * 1000;

/** backend id -> timestamp it may be tried again. */
const _cooldowns = new Map();

function _inCooldown(backend, now = Date.now()) {
  const until = _cooldowns.get(backend);
  if (!until) return false;
  if (until <= now) { _cooldowns.delete(backend); return false; }
  return true;
}

function _startCooldown(backend, now = Date.now()) {
  _cooldowns.set(backend, now + COOLDOWN_MS);
  log.info(`${backend} is on cooldown for ${COOLDOWN_MS / 60000} minutes`);
}

/** Clear every cooldown. Tests only. */
function _resetCooldownsForTests() {
  _cooldowns.clear();
}

/**
 * The backend `generate_image` runs on this profile, and the one behind it.
 *
 * @returns {{ primary: string|null, fallback: string|null }}
 */
function resolveImageBackends() {
  const bound = backendFor(resolveProviderProfile(), FEATURE.GENERATE_IMAGE);
  const fallback = fallbackBackendFor(bound);
  const usable = (b) => b === BACKEND.XAI || (b === BACKEND.CLOUDFLARE && isCloudflareConfigured());

  // A backend with no credentials is skipped outright rather
  // than attempted and allowed to fail.
  const primary = usable(bound) && !_inCooldown(bound) ? bound : null;
  const behind = fallback && usable(fallback) && !_inCooldown(fallback) ? fallback : null;
  if (primary) return { primary, fallback: behind };
  return { primary: behind, fallback: null };
}

/** The backend whose schema the tool should advertise, cooldowns aside. */
function declaredImageBackend() {
  const bound = backendFor(resolveProviderProfile(), FEATURE.GENERATE_IMAGE);
  if (bound === BACKEND.XAI) return BACKEND.XAI;
  return isCloudflareConfigured() ? BACKEND.CLOUDFLARE : null;
}

/**
 * What to do about a failed attempt. Three separate questions,
 * because one failure can answer them differently: a 429 falls back *and*
 * cools the primary down, a 500 retries once *before* falling back, and a
 * content-policy refusal does neither.
 *
 * @param {string} code - a CF_ERROR, or the same names produced on the xAI side
 * @returns {{ fallBack: boolean, retryPrimary: boolean, cooldown: boolean }}
 */
function failurePlan(code) {
  // Rule 2: a content-policy refusal is a decision, not an outage. Trying the
  // other backend would be routing around the provider's safety call.
  if (code === CF_ERROR.CONTENT_POLICY) {
    return { fallBack: false, retryPrimary: false, cooldown: false };
  }
  // Rule 3: rate-limited or out of budget — go elsewhere now, and stop probing
  // this one for a while.
  if (code === CF_ERROR.RATE_LIMIT || code === CF_ERROR.BUDGET) {
    return { fallBack: true, retryPrimary: false, cooldown: true };
  }
  // Rules 4 and 5: a credential or a transient failure is worth exactly one
  // more attempt at the primary before moving on.
  if (code === CF_ERROR.AUTH || code === CF_ERROR.TRANSIENT) {
    return { fallBack: true, retryPrimary: true, cooldown: false };
  }
  // Anything else (a malformed request, an unconfigured backend) is not fixed
  // by repeating it, but the other backend may still succeed.
  return { fallBack: true, retryPrimary: false, cooldown: false };
}

// -- Cloudflare FLUX ----------------------------------------------------------

/** Resolve the size the model asked for onto one FLUX really serves. */
function resolveFluxSize(name) {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return FLUX_SIZES[key] || FLUX_SIZES[FLUX_DEFAULT_SIZE];
}

/** Translate the xAI text-to-image shape into the closest FLUX size preset. */
function fluxSizeForAspectRatio(aspectRatio) {
  const key = typeof aspectRatio === 'string' ? aspectRatio.trim() : '';
  return XAI_ASPECT_TO_FLUX_SIZE[key] || FLUX_DEFAULT_SIZE;
}

/**
 * Whether an image request may move between two backends without changing the
 * operation the model requested. xAI reference calls are edits/compositions;
 * FLUX reference input only guides a new generation, so only text-to-image is
 * a valid xAI -> FLUX fallback.
 */
function canUseImageFallback(sourceBackend, targetBackend, referenceCount) {
  if (sourceBackend === targetBackend) return true;
  return sourceBackend === BACKEND.XAI
    && targetBackend === BACKEND.CLOUDFLARE
    && referenceCount === 0;
}

/**
 * Generate one image on Workers AI FLUX.
 *
 * Multipart only: the endpoint requires the multipart form shape.
 *
 * @param {object} req
 * @param {string} req.prompt
 * @param {string} [req.size] - a key of FLUX_SIZES
 * @param {Array<{buffer: Buffer, name: string, mime: string}>} [req.references]
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, ext?: string, error?: string, code?: string }>}
 */
async function generateWithFlux({ prompt, size, references = [], signal }) {
  const { width, height } = resolveFluxSize(size);
  const refs = references.slice(0, FLUX_MAX_REFERENCES);

  // Built per attempt: the client may retry on another account, and a FormData
  // whose body has been sent once cannot be sent again.
  const form = () => {
    const body = new FormData();
    body.append('prompt', prompt);
    body.append('width', String(width));
    body.append('height', String(height));
    for (const ref of refs) {
      body.append('image', new Blob([ref.buffer], { type: ref.mime || 'image/png' }), ref.name || 'reference.png');
    }
    return body;
  };

  const res = await callWorkersAi({
    model: envConfig.CLOUDFLARE_IMAGE_MODEL,
    body: form,
    signal
  });
  if (!res.ok) return { ok: false, error: res.error, code: res.code };

  const b64 = res.payload?.result?.image;
  if (typeof b64 !== 'string' || !b64) {
    return { ok: false, code: CF_ERROR.MALFORMED, error: 'Workers AI returned no image.' };
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    return { ok: false, code: CF_ERROR.MALFORMED, error: 'Workers AI returned an empty image.' };
  }
  const type = sniffImageType(buffer);
  if (!type) {
    return { ok: false, code: CF_ERROR.MALFORMED, error: 'Workers AI returned an unrecognized image format.' };
  }
  return { ok: true, buffer, ext: type.ext, mime: type.mime };
}

export {
  BACKEND,
  COOLDOWN_MS,
  FLUX_DEFAULT_SIZE,
  FLUX_MAX_REFERENCES,
  FLUX_SIZES,
  XAI_ASPECT_TO_FLUX_SIZE,
  _resetCooldownsForTests,
  canUseImageFallback,
  declaredImageBackend,
  failurePlan,
  fluxSizeForAspectRatio,
  generateWithFlux,
  resolveFluxSize,
  resolveImageBackends,
  _startCooldown as startCooldown
};
