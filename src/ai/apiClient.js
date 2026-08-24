// src/ai/apiClient.js
//
// HTTP plumbing for the xAI endpoints that are NOT the Responses main brain:
// Grok Imagine image/video and xAI TTS. Retry, timeout, structured
// request/response logging and log-directory quota live here.
//
// This module is limited to the xAI media stack, routed through the media
// backends. Main-brain requests use OpenAIResponsesTransport with a
// CredentialProvider.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import constants from '../config/constants.js';
import { getXaiServiceAuth, markXaiServiceStatus  } from './credentials/xaiServiceCredentials.js';
import { createLogger  } from '../utils/logger.js';
import { signalWithTimeout, sleepWithin } from '../utils/turnBudget.js';

const log = createLogger('API');
const apiLogDir = path.resolve(__dirname, '..', 'logs');
const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (monthly retention)
const LOG_CLEANUP_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour (scan interval; age gate is monthly)
const LOG_DIR_QUOTA_BYTES = 200 * 1024 * 1024;     // 200 MB hard cap on total log dir size

import crypto from 'crypto';

// Throttle window for _enforceLogDirQuota: the scan itself is O(n) (readdir +
// one statSync per file), so running it on every single log write — up to
// twice per round, MAX_TOOL_ROUNDS rounds per turn — would scan a directory
// that can hold thousands of files 100 times over. The 200 MB cap is a soft
// backstop (cleanupOldLogs() also runs hourly on an age basis), so skipping a
// scan for a few seconds under load is harmless.
const LOG_QUOTA_CHECK_INTERVAL_MS = 30_000;
let _lastQuotaCheckAt = 0;

/**
 * Enforce a total size quota on the log directory by deleting the oldest
 * files until the total size drops below LOG_DIR_QUOTA_BYTES. Throttled to
 * at most once per LOG_QUOTA_CHECK_INTERVAL_MS — see comment above.
 */
function _enforceLogDirQuota() {
  const now = Date.now();
  if (now - _lastQuotaCheckAt < LOG_QUOTA_CHECK_INTERVAL_MS) return;
  _lastQuotaCheckAt = now;
  try {
    if (!fs.existsSync(apiLogDir)) return;
    const files = fs.readdirSync(apiLogDir).filter(f => f.endsWith('.json'));
    let total = 0;
    const stats = [];
    for (const f of files) {
      try {
        const fp = path.join(apiLogDir, f);
        const st = fs.statSync(fp);
        total += st.size;
        stats.push({ fp, mtime: st.mtimeMs, size: st.size });
      } catch { /* ignore */ }
    }
    if (total <= LOG_DIR_QUOTA_BYTES) return;
    stats.sort((a, b) => a.mtime - b.mtime);
    let deleted = 0;
    for (const s of stats) {
      if (total <= LOG_DIR_QUOTA_BYTES) break;
      try {
        fs.unlinkSync(s.fp);
        total -= s.size;
        deleted++;
      } catch { /* ignore */ }
    }
    if (deleted > 0) log.info(`Log quota: deleted ${deleted} oldest file(s) to enforce ${Math.round(LOG_DIR_QUOTA_BYTES / 1024 / 1024)} MB cap.`);
  } catch (err) {
    log.warn(`Log quota enforcement failed: ${err.message}`);
  }
}

function ensureLogDir() {
  if (!fs.existsSync(apiLogDir)) {
    fs.mkdirSync(apiLogDir, { recursive: true });
  }
}

function cleanupOldLogs() {
  try {
    if (!fs.existsSync(apiLogDir)) return;
    const now = Date.now();
    const files = fs.readdirSync(apiLogDir);
    let deleted = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(apiLogDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > LOG_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch { }
    }
    if (deleted > 0) log.info(`Log cleanup: deleted ${deleted} old file(s)`);
  } catch (err) {
    log.warn(`Log cleanup failed: ${err.message}`);
  }
}

// Cleanup on startup and periodically
cleanupOldLogs();
const _logCleanupInterval = setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_MS);
_logCleanupInterval.unref();

function _getLogFilePath(prefix, timestamp) {
  const sanitized = timestamp.replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return path.join(apiLogDir, `${prefix}-${sanitized}-${rand}.json`);
}

function logApiRequest(modelName, apiUrl, body, extra = {}) {
  try {
    ensureLogDir();
    _enforceLogDirQuota();
    const now = new Date().toISOString();
    const entry = {
      timestamp: now,
      model: modelName,
      apiUrl,
      requestBody: body,
      ...extra
    };
    const serialized = JSON.stringify(entry, null, 2);
    const filePath = _getLogFilePath('api-request', now);
    fs.writeFileSync(filePath, serialized);
    return filePath;
  } catch (err) {
    log.warn(`Failed to write API request log: ${err.message}`);
    return null;
  }
}

function logApiResponse(modelName, apiUrl, responseBody, extra = {}) {
  try {
    ensureLogDir();
    _enforceLogDirQuota();
    const now = new Date().toISOString();
    const responseLogFile = _getLogFilePath('api-response', now);
    const entry = {
      timestamp: now,
      model: modelName,
      apiUrl,
      responseBody,
      ...extra
    };
    const serialized = JSON.stringify(entry, null, 2);
    fs.writeFileSync(responseLogFile, serialized);
    return responseLogFile;
  } catch (err) {
    log.warn(`Failed to write API response log: ${err.message}`);
    return null;
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
 * True when errMsg is an xAI HTTP 403 spending-limit body
 * (`personal-team-blocked:spending-limit`), either as a bare
 * `HTTP 403: {...}` line or nested inside a longer error string.
 * @param {string} errMsg
 * @returns {boolean}
 */
function _isGrokCreditExhaustedHttpBody(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  const marker = 'HTTP 403:';
  const idx = errMsg.indexOf(marker);
  const candidate = (idx === -1 ? errMsg : errMsg.slice(idx + marker.length)).trim();
  if (!candidate.startsWith('{')) return false;
  const tryParse = (raw) => {
    try {
      return JSON.parse(raw)?.code === 'personal-team-blocked:spending-limit';
    } catch {
      return false;
    }
  };
  if (tryParse(candidate)) return true;
  // Trailing junk after JSON (e.g. wrapped rethrow suffixes)
  const end = candidate.lastIndexOf('}');
  return end > 0 && tryParse(candidate.slice(0, end + 1));
}

/**
 * True when errMsg is the xAI HTTP 403 OAuth "bad-credentials" body
 * (`unauthenticated:bad-credentials` / "OAuth2 access token could not be
 * validated"). Once the SuperGrok team credits run out, xAI's spending-limit
 * body morphs into this after a while, so in this deployment it means the same
 * thing: credits exhausted, not a transient auth failure worth alerting the
 * admin. Accepts a bare `HTTP 403: {...}` line or one nested in a longer string.
 * @param {string} errMsg
 * @returns {boolean}
 */
function _isOAuthUnauthenticatedHttp403Body(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  const marker = 'HTTP 403:';
  const idx = errMsg.indexOf(marker);
  if (idx === -1) return false;
  const candidate = errMsg.slice(idx + marker.length).trim();
  const codeIsUnauthenticated = (raw) => {
    try {
      const code = JSON.parse(raw)?.code;
      return typeof code === 'string' && code.startsWith('unauthenticated');
    } catch {
      return false;
    }
  };
  if (candidate.startsWith('{')) {
    if (codeIsUnauthenticated(candidate)) return true;
    const end = candidate.lastIndexOf('}');
    if (end > 0 && codeIsUnauthenticated(candidate.slice(0, end + 1))) return true;
  }
  // Fallback on the human-readable OAuth validation message.
  return /could not be validated/i.test(candidate);
}

/** Stable error.code set by callApiWithRetry (English message kept for logs). */
const GROK_CREDIT_EXHAUSTED_CODE = 'GROK_CREDIT_EXHAUSTED';

/**
 * Credit exhaustion on an xAI media endpoint. Marking the error with a code
 * instead of notifying the admin is the whole point: a spent weekly allowance is
 * an expected state, and the tool result already tells the model what happened.
 * The main brain has its own typed equivalent (transport QUOTA + errorPolicy).
 * @param {string|null|undefined} errMsg
 * @returns {boolean}
 */
function _isGrokCreditExhaustedError(errMsg) {
  if (typeof errMsg !== 'string' || !errMsg) return false;
  return _isGrokCreditExhaustedHttpBody(errMsg) || _isOAuthUnauthenticatedHttp403Body(errMsg);
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
          continue;
        }

        throw new Error(errMsg);
      }

      await markXaiServiceStatus('ok', requestAccountId);
      return res;
    } catch (err) {
      if (callerSignal?.aborted) throw callerSignal.reason || err;
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
  throw new Error('xAI authenticated fetch failed');
}

export {
  callApiWithRetry,
  logApiResponse,
  fetchXaiWithOAuthRetry
};
