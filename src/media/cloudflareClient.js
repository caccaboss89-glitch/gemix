// src/media/cloudflareClient.js
//
// One way in to Cloudflare Workers AI.
//
// Two features use these accounts — Whisper for speech and FLUX for images —
// and they share one free daily allowance per account, so they also share the
// client that counts it. Keeping the transport here means the credentials are
// read in exactly one place and the ledger cannot be bypassed by a second
// caller rolling its own fetch.
//
// This is also where the account rotation happens, because it is the only layer
// that sees both halves of a refusal: the neuron ledger saying this call no
// longer fits in what the account has left, and Cloudflare saying the account
// is finished for the day. Either sends the call on to the next account, so a
// deployment that needs more than 10,000 neurons a day only has to add accounts
// to .env — but only the second is written down, because a call too big for
// what is left says nothing about a smaller one later today.
//
// The two models want different bodies: Whisper takes JSON with base64 audio,
// FLUX is multipart-only (a JSON body is refused outright with "required
// properties 'multipart'"). Both shapes live here rather than in the callers.

import { reserveNeurons } from './neuronLedger.js';
import {
  isCloudflareConfigured,
  markExhausted,
  markWorking,
  usableAccounts
} from './cloudflareAccounts.js';
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

function _url(accountId, model) {
  return `${API_BASE}/${accountId}/ai/run/${model}`;
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
 * Whether a refusal means this account is done for the day, as opposed to a
 * failure that says nothing about its allowance. AUTH is a credential that is
 * no longer usable; RATE_LIMIT on the free tier means the allowance is really
 * gone, our own estimate having been the optimistic one. Neither can improve
 * before the reset, so both are written down.
 */
function _accountIsSpent(code) {
  return code === CF_ERROR.AUTH || code === CF_ERROR.RATE_LIMIT;
}

/**
 * POST to one Workers AI model, rotating through the account pool until one
 * has both the allowance and the willingness to serve the call.
 *
 * @param {object} req
 * @param {string} req.model
 * @param {object|FormData|(() => object|FormData)} req.body - a plain object is
 *   sent as JSON; pass a factory when the body is a FormData, which cannot be
 *   replayed across accounts
 * @param {number} req.estimatedNeurons
 * @param {AbortSignal} [req.signal]
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{ ok: boolean, payload?: object, error?: string, code?: string, status?: number }>}
 */
async function callWorkersAi({ model, body, estimatedNeurons, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!isCloudflareConfigured()) {
    return { ok: false, code: CF_ERROR.UNCONFIGURED, error: 'Cloudflare Workers AI is not configured.' };
  }

  const accounts = usableAccounts();
  let budgetReason = null;
  let lastFailure = null;

  for (const account of accounts) {
    const reservation = await reserveNeurons(account.fingerprint, estimatedNeurons);
    if (!reservation.ok) {
      // Not enough left on this account for a call this size. A cheaper one may
      // still fit today, so the account keeps its place in the ring.
      budgetReason = reservation.reason;
      continue;
    }

    const attempt = await _attempt({ account, model, body, signal, timeoutMs, reservation });
    if (attempt.ok || !_accountIsSpent(attempt.code)) return attempt;

    log.warn(`Workers AI account ${account.fingerprint} is done for the day (${attempt.code}); rotating.`);
    lastFailure = attempt;
    await markExhausted(account.fingerprint);
  }

  // A call did go out and Cloudflare cut the account off: that answer is more
  // specific than "out of budget", and the fallback policy handles both alike.
  if (lastFailure) return lastFailure;

  // Nothing was ever sent: every account was either already spent or too low
  // for this call. With a single account its own numbers are the useful answer.
  return {
    ok: false,
    code: CF_ERROR.BUDGET,
    error: (accounts.length === 1 && budgetReason)
      || 'Every Cloudflare Workers AI account has spent its free allowance for today. It resets at 00:00 UTC.'
  };
}

/** One request on one account, settling its reservation whatever the outcome. */
async function _attempt({ account, model, body, signal, timeoutMs, reservation }) {
  const payloadBody = typeof body === 'function' ? body() : body;
  const isForm = typeof FormData !== 'undefined' && payloadBody instanceof FormData;
  let committed = false;
  try {
    const res = await fetch(_url(account.accountId, model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.apiToken}`,
        ...(isForm ? {} : { 'Content-Type': 'application/json' })
      },
      body: isForm ? payloadBody : JSON.stringify(payloadBody),
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
    await markWorking(account.fingerprint);
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
  CF_ERROR,
  REQUEST_TIMEOUT_MS,
  callWorkersAi,
  classifyFailure,
  isCloudflareConfigured
};
