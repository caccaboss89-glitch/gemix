// src/ai/apiClient.js
//
// HTTP plumbing for the xAI endpoints that are NOT the Responses main brain:
// Grok Imagine image/video and xAI TTS. Retry, timeout, structured
// request/response logging is shared with the main-brain transport.
//
// This module is limited to the xAI media stack, routed through the media
// backends. Main-brain requests use OpenAIResponsesTransport with a
// CredentialProvider.

import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';
import constants from '../config/constants.js';
import { getXaiServiceAuth, markXaiServiceStatus  } from './credentials/xaiServiceCredentials.js';
import { createLogger  } from '../utils/logger.js';
import { signalWithTimeout, sleepWithin } from '../utils/turnBudget.js';
import {
  initApiLogRetention,
  logApiRequest,
  logApiResponse,
  redactApiLogData
} from './apiLogs.js';

const log = createLogger('API');

function _formatRateLimitLog(status, errBody, headers) {
  const parts = [`HTTP ${status} (rate limit / quota)`];
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter) parts.push(`Retry-After: ${retryAfter}s`);
  for (const [key, value] of headers?.entries?.() || []) {
    const lower = key.toLowerCase();
    if (lower.includes('ratelimit') || lower.includes('rate-limit') || lower === 'x-request-id') {
      parts.push(`${key}: ${value}`);
    }
  }
  let detail = '';
  if (errBody && !errBody.startsWith('<!')) {
    try {
      const parsed = JSON.parse(errBody);
      const msg = parsed?.error?.message || parsed?.message || parsed?.detail;
      if (msg) detail = String(msg).slice(0, 300);
    } catch {
      detail = errBody.slice(0, 300);
    }
  }
  if (detail) parts.push(detail);
  return parts.join(' — ');
}

function _isOAuthCredentialError(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  if (/^HTTP 401\b/.test(errMsg)) return true;
  if (/^HTTP 403\b/.test(errMsg)
    && /bad-credentials|unauthenticated|could not be validated/i.test(errMsg)) {
    return true;
  }
  return false;
}

/**
 * The `code` field of a `HTTP 403: {...}` JSON body, tolerant of trailing
 * junk after the JSON (e.g. wrapped rethrow suffixes). Returns null when the
 * message carries no such marker or the body doesn't parse.
 * @param {string} errMsg
 * @returns {string|null}
 */
function _http403Code(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return null;
  const marker = 'HTTP 403:';
  const idx = errMsg.indexOf(marker);
  if (idx === -1) return null;
  const candidate = errMsg.slice(idx + marker.length).trim();
  if (!candidate.startsWith('{')) return null;
  const end = candidate.lastIndexOf('}');
  for (const raw of [candidate, end > 0 ? candidate.slice(0, end + 1) : null]) {
    if (!raw) continue;
    try {
      const code = JSON.parse(raw)?.code;
      if (typeof code === 'string') return code;
    } catch { /* try the trimmed variant */ }
  }
  return null;
}

/** Stable error.code set by callApiWithRetry (English message kept for logs). */
const GROK_CREDIT_EXHAUSTED_CODE = 'GROK_CREDIT_EXHAUSTED';

/**
 * Credit exhaustion on an xAI media endpoint. Marking the error with a code
 * instead of notifying the admin is the whole point: a spent weekly allowance is
 * an expected state, and the tool result already tells the model what happened.
 * The main brain has its own typed equivalent (transport QUOTA + errorPolicy).
 *
 * Covers the bare spending-limit body (`personal-team-blocked:spending-limit`)
 * and its later form: once the SuperGrok team credits run out, xAI's
 * spending-limit body morphs into an OAuth "bad-credentials" body
 * (`unauthenticated:bad-credentials` / "OAuth2 access token could not be
 * validated"), which in this deployment means the same thing.
 * @param {string|null|undefined} errMsg
 * @returns {boolean}
 */
function _isGrokCreditExhaustedError(errMsg) {
  if (typeof errMsg !== 'string' || !errMsg) return false;
  const code = _http403Code(errMsg);
  if (code === 'personal-team-blocked:spending-limit') return true;
  if (code && code.startsWith('unauthenticated')) return true;
  return errMsg.includes('HTTP 403:') && /could not be validated/i.test(errMsg);
}

/**
 * POST to an xAI media endpoint with retry and timeout logic.
 *
 * The bearer is resolved per attempt from the shared xAI CredentialProvider,
 * which refreshes proactively; a rejected credential forces one in-process
 * refresh before the retry.
 *
 * @param {string} modelName - Model name for logging (e.g., 'Grok-Imagine')
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @param {object} [logExtra] - Extra fields merged into the request log entry
 * @param {number} [timeoutMs] - Per-attempt request ceiling
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - caller cancellation / absolute turn deadline
 * @returns {Promise<Response>} The raw fetch Response
 */
async function callApiWithRetry(
  modelName,
  apiUrl,
  body,
  logExtra = {},
  timeoutMs = constants.API_TIMEOUT_MS,
  opts = {}
) {
  logApiRequest(modelName, apiUrl, body, logExtra);
  const callerSignal = opts.signal || null;
  let forceCredentialRefresh = false;
  let rejectedAccountId = null;
  let credentialRefreshAttempted = false;
  for (let attempt = 1; attempt <= constants.MAX_API_RETRIES; attempt++) {
    const attemptStarted = Date.now();
    let requestAccountId = null;
    try {
      if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
      const { token, accountId } = await getXaiServiceAuth({
        forceRefresh: forceCredentialRefresh,
        accountId: rejectedAccountId
      });
      requestAccountId = accountId;
      forceCredentialRefresh = false;
      rejectedAccountId = null;
      const operationSignal = signalWithTimeout(callerSignal, timeoutMs);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal: operationSignal
      });
      const duration = Date.now() - attemptStarted;

      if (!res.ok) {
        const errBody = await res.text();
        const shortErr = errBody.startsWith('<!') ? 'Cloudflare error' : errBody;
        if (res.status === 429) {
          log.warn(`   ${_formatRateLimitLog(res.status, errBody, res.headers)}`);
        }
        throw new Error(`HTTP ${res.status}: ${shortErr}`);
      }

      log.debug(`   Model: ${modelName} - ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      await markXaiServiceStatus('ok', requestAccountId);
      return res;
    } catch (err) {
      if (callerSignal?.aborted) throw callerSignal.reason || err;
      const attemptMs = Date.now() - attemptStarted;
      const isTimeout = err.name === 'AbortError'
        || err.name === 'TimeoutError'
        || (err.message && err.message.includes('524'));
      const isNetworkError = err.message && /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(err.message);
      const is429 = err.message && /^HTTP 429/.test(err.message);
      const isRetryable = isTimeout || isNetworkError || (err.message && /^HTTP (401|429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError'
        ? `Timeout (request aborted after ${timeoutMs / 1000}s)`
        : err.message;

      if (_isOAuthCredentialError(errMsg) && !credentialRefreshAttempted) {
        credentialRefreshAttempted = true;
        await markXaiServiceStatus('auth_failed', requestAccountId);
        forceCredentialRefresh = true;
        rejectedAccountId = requestAccountId;
        // A refresh is not a failed attempt: give back the budget so the retry
        // still happens when the rejection landed on the last one.
        attempt--;
        log.info('   Retrying API call with a refreshed xAI credential...');
        continue;
      }

      if (isRetryable && attempt < constants.MAX_API_RETRIES) {
        const delay = attempt * 3000;
        const waitHint = is429
          ? ' (rate limit — check Retry-After / xAI console for quota reset)'
          : '';
        log.warn(
          `   API attempt ${attempt}/${constants.MAX_API_RETRIES} failed after ${Math.round(attemptMs / 1000)}s: ${errMsg}`
          + ` — pausing ${delay / 1000}s before retry ${attempt + 1}/${constants.MAX_API_RETRIES}${waitHint}...`
        );
        await sleepWithin(delay, callerSignal);
        if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
        continue;
      }

      log.error(`   API error after ${attempt} attempt(s), last try ${Math.round(attemptMs / 1000)}s: ${errMsg}`);
      if (_isGrokCreditExhaustedError(errMsg)) {
        await markXaiServiceStatus('quota', requestAccountId);
        const creditErr = new Error(`${modelName} API credit exhausted after ${attempt} attempt(s): ${errMsg}`);
        creditErr.code = GROK_CREDIT_EXHAUSTED_CODE;
        throw creditErr;
      }
      await notifyAdmin(`API (${modelName})`, `Error after ${attempt} attempt(s): ${errMsg}`);
      throw new Error(`${modelName} API unreachable after ${attempt} attempt(s): ${errMsg}${ADMIN_NOTIFIED_SUFFIX}`);
    }
  }
  // Defensive invariant: every path above returns or throws, so callers never
  // receive an undefined Response.
  throw new Error(`${modelName} API unreachable: retry loop exhausted`);
}

/**
 * Authenticated GET/POST against an xAI endpoint, with one credential refresh.
 * Used by xAI TTS, STT and the Grok Imagine video poll.
 *
 * `opts.signal` is the caller's own abort — a turn that ran out of budget, or a
 * user who stopped waiting. It is combined with the per-attempt timeout, so
 * either can end the request and the retry loop stops on the caller's.
 */
async function fetchXaiWithOAuthRetry(url, options = {}, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : constants.API_TIMEOUT_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : constants.MAX_API_RETRIES;
  const callerSignal = opts.signal || null;
  let forceCredentialRefresh = false;
  let rejectedAccountId = null;
  let credentialRefreshAttempted = false;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let requestAccountId = null;
    try {
      if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
      const { token, accountId } = await getXaiServiceAuth({
        forceRefresh: forceCredentialRefresh,
        accountId: rejectedAccountId
      });
      requestAccountId = accountId;
      forceCredentialRefresh = false;
      rejectedAccountId = null;
      const operationSignal = signalWithTimeout(callerSignal, timeoutMs);

      const res = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`
        },
        signal: operationSignal
      });
      if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const shortErr = errBody.startsWith('<!') ? 'Cloudflare error' : errBody;
        const errMsg = `HTTP ${res.status}: ${shortErr}`;

        if (_isOAuthCredentialError(errMsg) && !credentialRefreshAttempted) {
          credentialRefreshAttempted = true;
          await markXaiServiceStatus('auth_failed', requestAccountId);
          forceCredentialRefresh = true;
          rejectedAccountId = requestAccountId;
          lastError = new Error(errMsg);
          // A refresh is not a failed attempt: give back the budget so the
          // retry still happens when the rejection landed on the last one.
          attempt--;
          continue;
        }

        throw new Error(errMsg);
      }

      await markXaiServiceStatus('ok', requestAccountId);
      return res;
    } catch (err) {
      if (callerSignal?.aborted) throw callerSignal.reason || err;
      lastError = err;
      const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError';
      const isRetryable = isTimeout
        || (err.message && /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(err.message))
        || (err.message && /^HTTP (401|429|500|502|503|504)/.test(err.message));
      if (isRetryable && attempt < maxAttempts) {
        await sleepWithin(attempt * 2000, callerSignal);
        if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('xAI authenticated fetch failed: retry budget exhausted');
}

export {
  callApiWithRetry,
  logApiResponse,
  fetchXaiWithOAuthRetry,
  initApiLogRetention,
  redactApiLogData as _redactInlineData
};
