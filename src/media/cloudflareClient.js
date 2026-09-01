// src/media/cloudflareClient.js
//
// One way in to Cloudflare Workers AI.
//
// Two features use these accounts — Whisper for speech and FLUX for images —
// and they share one free daily allowance per account, so they also share the
// client that spends it. Keeping the transport here means the credentials are
// read in exactly one place.
//
// This is also where the account rotation happens, driven purely by what
// Cloudflare answers. There is no local budget arithmetic: Cloudflare is the
// only authority on what an account has left, and any estimate we made ahead of
// the call would be wrong in the one direction that matters, refusing calls
// that would have gone through. So a call goes out, and if the account is
// finished it says so and the next one is tried.
//
// Three refusals are told apart, because they mean different things:
//
//   401/403          the credential is unusable
//   429 + "daily free allocation"  this account's neurons are gone until 00:00 UTC
//   429 (anything else, e.g. 3040) a burst/capacity limit, gone in seconds
//
// The first two retire the account for the day; the third is transient and must
// not, or one busy moment would throw away an account with a full allowance.
//
// The two models want different bodies: Whisper takes JSON with base64 audio,
// FLUX is multipart-only (a JSON body is refused outright with "required
// properties 'multipart'"). Both shapes live here rather than in the callers.

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

/** How Cloudflare words the end of the free daily allowance, inside a 429. */
const NEURONS_SPENT_RE = /daily free allocation|free allocation of .* neurons|out of neurons/i;

const EXHAUSTED_POOL_ERROR =
  'Every Cloudflare Workers AI account has spent its free allowance for today. It resets at 00:00 UTC.';

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
  // A 429 is either "this account is done for the day" or "too many at once".
  // Only the first is worth remembering, so the wording decides.
  if (status === 429) return NEURONS_SPENT_RE.test(message || '') ? CF_ERROR.BUDGET : CF_ERROR.RATE_LIMIT;
  if (/content policy|safety|nsfw|prohibited/i.test(message || '')) return CF_ERROR.CONTENT_POLICY;
  if (status >= 500 || status === 408) return CF_ERROR.TRANSIENT;
  if (status >= 400) return CF_ERROR.MALFORMED;
  return CF_ERROR.TRANSIENT;
}

/**
 * Whether a refusal means this account is finished until the daily reset, as
 * opposed to one that says nothing about its allowance. A burst limit is
 * explicitly not one of these: it clears on its own in seconds.
 */
function _accountIsSpent(code) {
  return code === CF_ERROR.AUTH || code === CF_ERROR.BUDGET;
}

/**
 * POST to one Workers AI model, moving down the account pool for as long as the
 * accounts themselves are the thing refusing.
 *
 * @param {object} req
 * @param {string} req.model
 * @param {object|FormData|(() => object|FormData)} req.body - a plain object is
 *   sent as JSON; pass a factory when the body is a FormData, which cannot be
 *   replayed across accounts
 * @param {AbortSignal} [req.signal]
 * @param {number} [req.timeoutMs]
 * @returns {Promise<{ ok: boolean, payload?: object, error?: string, code?: string, status?: number }>}
 */
async function callWorkersAi({ model, body, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!isCloudflareConfigured()) {
    return { ok: false, code: CF_ERROR.UNCONFIGURED, error: 'Cloudflare Workers AI is not configured.' };
  }

  let lastFailure = null;
  for (const account of usableAccounts()) {
    const attempt = await _attempt({ account, model, body, signal, timeoutMs });
    if (attempt.ok || !_accountIsSpent(attempt.code)) return attempt;

    log.warn(`Workers AI account ${account.fingerprint} is done for the day (${attempt.code}); rotating.`);
    lastFailure = attempt;
    await markExhausted(account.fingerprint);
  }

  // Either the pool was already empty or this call emptied it, and both mean
  // the same thing to the caller: the pool-wide wording is the honest one. A
  // credential Cloudflare would not accept is the exception — that is a
  // deployment fault rather than a spent allowance, so it is passed through.
  return lastFailure?.code === CF_ERROR.AUTH
    ? lastFailure
    : { ok: false, code: CF_ERROR.BUDGET, error: EXHAUSTED_POOL_ERROR };
}

/** One request on one account. */
async function _attempt({ account, model, body, signal, timeoutMs }) {
  const payloadBody = typeof body === 'function' ? body() : body;
  const isForm = typeof FormData !== 'undefined' && payloadBody instanceof FormData;
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

    await markWorking(account.fingerprint);
    return { ok: true, payload, status: res.status };
  } catch (err) {
    const timedOut = err.name === 'AbortError' || err.name === 'TimeoutError';
    return {
      ok: false,
      code: CF_ERROR.TRANSIENT,
      error: timedOut ? 'Cloudflare did not answer in time.' : `Cloudflare is unreachable: ${err.message}`
    };
  }
}

export {
  CF_ERROR,
  EXHAUSTED_POOL_ERROR,
  REQUEST_TIMEOUT_MS,
  callWorkersAi,
  classifyFailure,
  isCloudflareConfigured
};
