// src/media/cloudflareClient.js
//
// One way in to Cloudflare Workers AI (spec §11.2).
//
// Two features use this account — Whisper for speech and FLUX for images — and
// they share one free daily allowance, so they also share the client that
// counts it. Keeping the transport here means the credential is read in exactly
// one place and the ledger cannot be bypassed by a second caller rolling its
// own fetch.
//
// The two models want different bodies: Whisper takes JSON with base64 audio,
// FLUX is multipart-only (a JSON body is refused outright with "required
// properties 'multipart'"). Both shapes live here rather than in the callers.

import envConfig from '../config/env.js';
import { reserveNeurons } from './neuronLedger.js';
import { createLogger } from '../utils/logger.js';
import { signalWithTimeout } from '../utils/turnBudget.js';

const log = createLogger('Cloudflare');

const API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const REQUEST_TIMEOUT_MS = 180 * 1000;

/** Why a call did not produce a result, in the terms the fallback policy uses. */
const CF_ERROR = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED',
  BUDGET: 'BUDGET',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  CONTENT_POLICY: 'CONTENT_POLICY',
  TRANSIENT: 'TRANSIENT',
  MALFORMED: 'MALFORMED'
});

/** True when this deployment has Workers AI credentials at all. */
function isCloudflareConfigured() {
  return Boolean(envConfig.CLOUDFLARE_AI_ACCOUNT_ID && envConfig.CLOUDFLARE_AI_API_TOKEN);
}

function _url(model) {
  return `${API_BASE}/${envConfig.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${model}`;
}

/** Cloudflare puts the useful part of a failure in `errors[]`. */
function _errorMessage(payload, raw) {
  const first = payload?.errors?.[0];
  if (first?.message) return String(first.message);
  return String(raw || '').slice(0, 300);
}

/** Map an HTTP status and message onto the taxonomy the fallback policy reads. */
function classifyFailure(status, message) {
  if (status === 401 || status === 403) return CF_ERROR.AUTH;
  if (status === 429) return CF_ERROR.RATE_LIMIT;
  if (/content policy|safety|nsfw|prohibited/i.test(message || '')) return CF_ERROR.CONTENT_POLICY;
  if (status >= 500 || status === 408) return CF_ERROR.TRANSIENT;
  if (status >= 400) return CF_ERROR.MALFORMED;
  return CF_ERROR.TRANSIENT;
}

/**
 * POST to one Workers AI model, with the ledger checked before and updated
 * after.
 *
 * @param {object} req
 * @param {string} req.model
 * @param {object|FormData} req.body - a plain object is sent as JSON
 * @param {number} req.estimatedNeurons
 * @param {AbortSignal} [req.signal]
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{ ok: boolean, payload?: object, error?: string, code?: string, status?: number }>}
 */
async function callWorkersAi({ model, body, estimatedNeurons, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!isCloudflareConfigured()) {
    return { ok: false, code: CF_ERROR.UNCONFIGURED, error: 'Cloudflare Workers AI is not configured.' };
  }

  const reservation = await reserveNeurons(estimatedNeurons);
  if (!reservation.ok) {
    return { ok: false, code: CF_ERROR.BUDGET, error: reservation.reason };
  }

  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let committed = false;
  try {
    const res = await fetch(_url(model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${envConfig.CLOUDFLARE_AI_API_TOKEN}`,
        ...(isForm ? {} : { 'Content-Type': 'application/json' })
      },
      body: isForm ? body : JSON.stringify(body),
      signal: signalWithTimeout(signal, timeoutMs)
    });
    const raw = await res.text();
    let payload = null;
    try { payload = JSON.parse(raw); } catch { /* reported through the classifier */ }

    if (!res.ok || payload?.success === false) {
      const message = _errorMessage(payload, raw);
      const code = classifyFailure(res.status, message);
      log.warn(`Workers AI ${model} failed (HTTP ${res.status}, ${code}): ${message}`);
      return { ok: false, code, error: message, status: res.status };
    }

    // Only a call that produced something consumes the reservation.
    committed = await reservation.commit();
    if (!committed) log.warn(`Workers AI ${model} succeeded but its neuron reservation could not be committed`);
    return { ok: true, payload, status: res.status };
  } catch (err) {
    const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
    return {
      ok: false,
      code: CF_ERROR.TRANSIENT,
      error: timedOut ? 'Cloudflare did not answer in time.' : `Cloudflare is unreachable: ${err.message}`
    };
  } finally {
    if (!committed) await reservation.release();
  }
}

export {
  API_BASE,
  CF_ERROR,
  REQUEST_TIMEOUT_MS,
  callWorkersAi,
  classifyFailure,
  isCloudflareConfigured
};
