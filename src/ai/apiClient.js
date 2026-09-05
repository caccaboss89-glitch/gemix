// src/ai/apiClient.js
//
// HTTP plumbing for the xAI endpoints that are NOT the Responses main brain:
// Grok Imagine image/video, xAI TTS and xAI STT. Retry, timeout and
// request/response logging are shared with the main-brain transport.
//
// This module is limited to the xAI media stack, routed through the media
// backends. Main-brain requests use OpenAIResponsesTransport with a
// CredentialProvider.

import crypto from 'node:crypto';
import { buildAdminNotificationNote, notifyAdminDetailed } from '../utils/adminNotifier.js';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
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

function _headersForLog(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function _requestBodyForLog(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') {
    try { return JSON.parse(body); }
    catch { return body; }
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields = {};
    for (const [key, value] of body.entries()) {
      const logged = typeof value === 'string'
        ? value
        : {
          filename: typeof value?.name === 'string' ? value.name : null,
          type: typeof value?.type === 'string' ? value.type : null,
          size: Number.isFinite(value?.size) ? value.size : null
        };
      if (Object.hasOwn(fields, key)) {
        fields[key] = Array.isArray(fields[key]) ? [...fields[key], logged] : [fields[key], logged];
      } else {
        fields[key] = logged;
      }
    }
    return { type: 'multipart/form-data', fields };
  }
  return body;
}

function _parseLoggedText(text) {
  if (!text) return '';
  try { return JSON.parse(text); }
  catch { return text; }
}

/** Read a clone so logging never consumes the Response returned to its caller. */
async function _responseForLog(response) {
  const headers = _headersForLog(response?.headers);
  const contentType = String(response?.headers?.get?.('content-type') || '');
  const http = { status: response?.status ?? null, headers };
  if (!response?.clone) return { http, body: '<response body unavailable>' };
  const clone = response.clone();
  if (/^(?:audio|image|video)\//i.test(contentType) || /^application\/octet-stream/i.test(contentType)) {
    return { http, body: Buffer.from(await clone.arrayBuffer()) };
  }
  return { http, body: _parseLoggedText(await clone.text()) };
}

function _writeServiceLog(kind, label, url, body, extra) {
  if (kind === 'request') return logApiRequest(label, url, body, extra);
  return logApiResponse(label, url, body, extra);
}

async function _writeResponseSnapshot(label, url, response, extra) {
  try {
    _writeServiceLog('response', label, url, await _responseForLog(response), extra);
  } catch (err) {
    _writeServiceLog('response', label, url, {
      http: {
        status: response?.status ?? null,
        headers: _headersForLog(response?.headers)
      },
      error: { name: err.name, message: `Could not capture response body: ${err.message}` }
    }, extra);
  }
}

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

function _isCredentialRejection(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  if (/^HTTP 401\b/.test(errMsg)) return true;
  if (/^HTTP 403\b/.test(errMsg)
    && /bad-credentials|unauthenticated|could not be validated|(?:api[ _-]?key|token).*(?:invalid|revoked|rejected)|(?:invalid|revoked|rejected).*(?:api[ _-]?key|token)/i.test(errMsg)) {
    return true;
  }
  return false;
}

/** Only OAuth credentials can be refreshed after an upstream rejection. */
function _isOAuthCredentialError(errMsg) {
  return !envConfig.XAI_USE_API_KEY && _isCredentialRejection(errMsg);
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
 * The explicit spending-limit code is quota under either auth mode. Once a
 * SuperGrok OAuth allowance runs out it can instead surface as
 * `unauthenticated:bad-credentials` / "OAuth2 access token could not be
 * validated". A static API key can produce that same text when it is bad or
 * revoked, so only OAuth may reinterpret it as quota.
 * @param {string|null|undefined} errMsg
 * @returns {boolean}
 */
function _isGrokCreditExhaustedError(errMsg) {
  if (typeof errMsg !== 'string' || !errMsg) return false;
  const code = _http403Code(errMsg);
  if (code === 'personal-team-blocked:spending-limit') return true;
  if (envConfig.XAI_USE_API_KEY) return false;
  if (code && code.startsWith('unauthenticated')) return true;
  return errMsg.includes('HTTP 403:') && /could not be validated/i.test(errMsg);
}

/** The auth/quota distinction shared by media retry and status handling. */
function _classifyXaiServiceAuthOrQuota(errMsg) {
  if (_isGrokCreditExhaustedError(errMsg)) return 'QUOTA';
  if (_isCredentialRejection(errMsg)) return 'AUTH';
  return null;
}

function _isRetryableXaiError(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  const message = typeof err?.message === 'string' ? err.message : '';
  return /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(message)
    || /^HTTP (401|429|500|502|503|504|524)/.test(message);
}

/**
 * One request engine for every authenticated xAI media endpoint.
 * Provider status, refresh, logging and backoff live here so callers cannot
 * drift on how a rejected account is classified.
 */
async function _runXaiServiceRequest({
  label,
  url,
  fetchOptions,
  logBody,
  logExtra = {},
  timeoutMs,
  maxAttempts,
  callerSignal,
  retryDelayBaseMs,
  warnRateLimit = false,
  terminalError,
  credentialAccess = {
    get: getXaiServiceAuth,
    mark: markXaiServiceStatus
  },
  logTraffic = true
}) {
  const apiLogId = crypto.randomUUID();
  let networkAttempt = 0;
  let forceCredentialRefresh = false;
  let rejectedAccountId = null;
  let credentialRefreshAttempted = false;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStarted = Date.now();
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const logMeta = {
      ...logExtra,
      apiLogId,
      transport: 'xai-service',
      attempt: ++networkAttempt,
      method
    };
    let requestAccountId = null;
    let responseLogged = false;

    try {
      if (callerSignal?.aborted) {
        throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
      }
      const auth = await credentialAccess.get({
        forceRefresh: forceCredentialRefresh,
        accountId: rejectedAccountId
      });
      requestAccountId = auth.accountId;
      forceCredentialRefresh = false;
      rejectedAccountId = null;
      const operationSignal = signalWithTimeout(callerSignal, timeoutMs);
      const headers = {
        ...(fetchOptions.headers || {}),
        Authorization: `Bearer ${auth.token}`
      };

      if (logTraffic) _writeServiceLog('request', label, url, logBody, logMeta);
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: operationSignal
      });
      if (callerSignal?.aborted) {
        throw callerSignal.reason || new DOMException('Aborted', 'AbortError');
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        if (logTraffic) {
          _writeServiceLog('response', label, url, {
            http: { status: response.status, headers: _headersForLog(response.headers) },
            body: _parseLoggedText(bodyText)
          }, { ...logMeta, durationMs: Date.now() - attemptStarted });
        }
        responseLogged = true;
        if (warnRateLimit && response.status === 429) {
          log.warn(`   ${_formatRateLimitLog(response.status, bodyText, response.headers)}`);
        }
        const detail = bodyText.startsWith('<!') ? 'Cloudflare error' : bodyText;
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }

      if (logTraffic) {
        await _writeResponseSnapshot(label, url, response, {
          ...logMeta,
          durationMs: Date.now() - attemptStarted
        });
      }
      responseLogged = true;
      await credentialAccess.mark('ok', requestAccountId);
      return response;
    } catch (err) {
      const attemptMs = Date.now() - attemptStarted;
      if (logTraffic && !responseLogged) {
        _writeServiceLog('response', label, url, {
          http: null,
          error: { name: err.name, message: err.message }
        }, { ...logMeta, durationMs: attemptMs });
      }
      if (callerSignal?.aborted) throw callerSignal.reason || err;

      lastError = err;
      const errMsg = err.name === 'AbortError'
        ? `Timeout (request aborted after ${timeoutMs / 1000}s)`
        : err.message;

      if (_isOAuthCredentialError(errMsg) && !credentialRefreshAttempted) {
        credentialRefreshAttempted = true;
        await credentialAccess.mark('auth_failed', requestAccountId);
        forceCredentialRefresh = true;
        rejectedAccountId = requestAccountId;
        attempt--;
        log.info('   Retrying API call with a refreshed xAI credential...');
        continue;
      }

      if (_isRetryableXaiError(err) && attempt < maxAttempts) {
        const delay = attempt * retryDelayBaseMs;
        log.warn(
          `   API attempt ${attempt}/${maxAttempts} failed after ${Math.round(attemptMs / 1000)}s: ${errMsg}`
          + ` — pausing ${delay / 1000}s before retry ${attempt + 1}/${maxAttempts}...`
        );
        await sleepWithin(delay, callerSignal);
        continue;
      }

      const classification = _classifyXaiServiceAuthOrQuota(errMsg);
      if (classification === 'QUOTA') await credentialAccess.mark('quota', requestAccountId);
      if (classification === 'AUTH') await credentialAccess.mark('auth_failed', requestAccountId);
      throw await terminalError({
        error: err,
        errorMessage: errMsg,
        attempt,
        classification,
        accountId: requestAccountId
      });
    }
  }

  throw lastError || new Error(`${label} request failed: retry budget exhausted`);
}

/**
 * POST to an xAI media endpoint with retry and timeout logic.
 *
 * The bearer is resolved per attempt from the shared xAI CredentialProvider,
 * which refreshes proactively. An OAuth credential rejected by xAI forces one
 * in-process refresh; a static API key is reported as AUTH without a fake
 * refresh attempt.
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
  const callerSignal = opts.signal || null;
  return _runXaiServiceRequest({
    label: modelName,
    url: apiUrl,
    fetchOptions: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    logBody: _requestBodyForLog(body),
    logExtra,
    timeoutMs,
    maxAttempts: constants.MAX_API_RETRIES,
    callerSignal,
    retryDelayBaseMs: 3000,
    warnRateLimit: true,
    terminalError: async ({ errorMessage, attempt, classification }) => {
      log.error(`   API error after ${attempt} attempt(s): ${errorMessage}`);
      if (classification === 'QUOTA') {
        const creditErr = new Error(
          `${modelName} API credit exhausted after ${attempt} attempt(s): ${errorMessage}`
        );
        creditErr.code = GROK_CREDIT_EXHAUSTED_CODE;
        return creditErr;
      }
      const notification = await notifyAdminDetailed(
        `API (${modelName})`,
        `Error after ${attempt} attempt(s): ${errorMessage}`
      );
      return new Error(
        `${modelName} API unreachable after ${attempt} attempt(s): ${errorMessage}`
        + buildAdminNotificationNote(notification)
      );
    }
  });
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
  const label = typeof opts.logLabel === 'string' && opts.logLabel.trim()
    ? opts.logLabel.trim()
    : 'xAI-Service';
  return _runXaiServiceRequest({
    label,
    url,
    fetchOptions: options,
    logBody: {
      method: String(options.method || 'GET').toUpperCase(),
      headers: _headersForLog(options.headers),
      body: _requestBodyForLog(options.body)
    },
    timeoutMs,
    maxAttempts,
    callerSignal,
    retryDelayBaseMs: 2000,
    terminalError: async ({ error }) => error
  });
}

export {
  _classifyXaiServiceAuthOrQuota,
  _isGrokCreditExhaustedError,
  _isOAuthCredentialError,
  _requestBodyForLog,
  _responseForLog,
  _runXaiServiceRequest,
  callApiWithRetry,
  logApiResponse,
  fetchXaiWithOAuthRetry,
  initApiLogRetention,
  redactApiLogData as _redactInlineData
};
