// src/ai/apiClient.js
//
// Centralized API client for all direct xAI LLM calls (`/v1/responses`).
// Reads the OAuth token from config/xaiAuth.js on every attempt (the auth
// file is refreshed externally), provides retry + timeout logic, structured
// request/response logging, and log directory quota enforcement.

const fs = require('fs');
const path = require('path');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { MAX_API_RETRIES, API_TIMEOUT_MS } = require('../config/constants');
const { XAI_USE_API_KEY } = require('../config/env');
const { getXaiAuth } = require('../config/xaiAuth');
const { createLogger } = require('../utils/logger');
const { refreshHermesOAuth } = require('../utils/hermesAuthRefresh');
const { isXaiFileDownloadError } = require('../utils/refreshXaiMessageUrls');

const log = createLogger('API');
const apiLogDir = path.resolve(__dirname, '..', 'logs');
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOG_CLEANUP_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const LOG_DIR_QUOTA_BYTES = 200 * 1024 * 1024;     // 200 MB hard cap on total log dir size

const crypto = require('crypto');

/**
 * Enforce a total size quota on the log directory by deleting the oldest
 * files until the total size drops below LOG_DIR_QUOTA_BYTES.
 * Cheap to call before every write because it short-circuits when below cap.
 */
function _enforceLogDirQuota() {
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
      ...extra,
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
      ...extra,
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

/** Stable error.code set by callApiWithRetry (English message kept for logs). */
const GROK_CREDIT_EXHAUSTED_CODE = 'GROK_CREDIT_EXHAUSTED';

/**
 * Canonical detector for SuperGrok / xAI team spending-limit exhaustion.
 * Accepts Error or string. True for:
 *   - err.code === GROK_CREDIT_EXHAUSTED_CODE
 *   - the rethrow from callApiWithRetry ("… API credit exhausted …")
 *   - raw / nested `HTTP 403` JSON with code personal-team-blocked:spending-limit
 * @param {Error|string|null|undefined} errOrMsg
 * @returns {boolean}
 */
function isGrokCreditExhaustedError(errOrMsg) {
  if (errOrMsg && typeof errOrMsg === 'object' && errOrMsg.code === GROK_CREDIT_EXHAUSTED_CODE) {
    return true;
  }
  const errMsg = typeof errOrMsg === 'string'
    ? errOrMsg
    : (errOrMsg && typeof errOrMsg.message === 'string' ? errOrMsg.message : null);
  if (!errMsg) return false;
  // English log marker written by callApiWithRetry (keep in sync with throw below)
  if (errMsg.includes('API credit exhausted')) return true;
  return _isGrokCreditExhaustedHttpBody(errMsg);
}

/**
 * Unified xAI API client with retry and timeout logic.
 * The bearer token is resolved per attempt from the auth file; a 401 forces
 * a fresh read on the next attempt (the external refresher may have rotated
 * the token between attempts).
 *
 * @param {string} modelName - Model name for logging (e.g., 'Grok')
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @returns {Promise<Response>} The raw fetch Response
 */
async function callApiWithRetry(modelName, apiUrl, body, logExtra = {}, timeoutMs = API_TIMEOUT_MS) {
  logApiRequest(modelName, apiUrl, body, logExtra);
  let forceTokenReload = false;
  let hermesRefreshAttempted = false;
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    let timer;
    const attemptStarted = Date.now();
    try {
      const { token } = getXaiAuth(forceTokenReload);
      forceTokenReload = false;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const duration = Date.now() - attemptStarted;

      if (!res.ok) {
        const errBody = await res.text();
        const shortErr = errBody.startsWith('<!') ? 'Cloudflare error' : errBody;
        if (res.status === 429) {
          log.warn(`   ${_formatRateLimitLog(res.status, errBody, res.headers)}`);
        }
        if (res.status === 401) {
          // Token likely rotated on disk between our cached read and now.
          forceTokenReload = true;
        }
        throw new Error(`HTTP ${res.status}: ${shortErr}`);
      }

      log.debug(`   Model: ${modelName} - ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      const attemptMs = Date.now() - attemptStarted;
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('524'));
      const isNetworkError = err.message && /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(err.message);
      const is429 = err.message && /^HTTP 429/.test(err.message);
      const isRetryable = isTimeout || isNetworkError || (err.message && /^HTTP (401|429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError'
        ? `Timeout (request aborted after ${timeoutMs / 1000}s)`
        : err.message;

      if (!XAI_USE_API_KEY && _isOAuthCredentialError(errMsg) && !hermesRefreshAttempted) {
        hermesRefreshAttempted = true;
        try {
          await refreshHermesOAuth();
          forceTokenReload = true;
          log.info('   Retrying API call with refreshed OAuth credentials...');
          continue;
        } catch (refreshErr) {
          log.error(`   Hermes OAuth refresh failed: ${refreshErr.message}`);
        }
      }

      if (isRetryable && attempt < MAX_API_RETRIES) {
        const delay = attempt * 3000;
        const waitHint = is429
          ? ' (rate limit — check Retry-After / xAI console for quota reset)'
          : '';
        log.warn(
          `   API attempt ${attempt}/${MAX_API_RETRIES} failed after ${Math.round(attemptMs / 1000)}s: ${errMsg}`
          + ` — pausing ${delay / 1000}s before retry ${attempt + 1}/${MAX_API_RETRIES}${waitHint}...`,
        );
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      log.error(`   API error after ${attempt} attempt(s), last try ${Math.round(attemptMs / 1000)}s: ${errMsg}`);
      if (isXaiFileDownloadError(errMsg) && logExtra.deferStaleFileUrlError) {
        const staleErr = new Error(errMsg);
        staleErr.code = 'XAI_STALE_FILE_URL';
        throw staleErr;
      }
      if (isGrokCreditExhaustedError(errMsg)) {
        const creditErr = new Error(`${modelName} API credit exhausted after ${attempt} attempt(s): ${errMsg}`);
        creditErr.code = GROK_CREDIT_EXHAUSTED_CODE;
        throw creditErr;
      }
      await notifyAdmin(`API (${modelName})`, `Error after ${attempt} attempt(s): ${errMsg}`);
      throw new Error(`${modelName} API unreachable after ${attempt} attempt(s): ${errMsg}${ADMIN_NOTIFIED_SUFFIX}`);
    }
  }
}

/**
 * Call an AI model on the xAI Responses API (`/v1/responses`) and return
 * the parsed raw payload (not yet adapted to chat-completion shape).
 *
 * Callers (aiProvider.callAI for the main brain, and other
 * sub-agent) translate `output[]` via responsesToAssistantMessage into the
 * chat-style message shape the handler expects.
 *
 * @param {string} modelName
 * @param {object} body
 * @returns {Promise<object>} The full parsed JSON body
 */
async function callResponsesModel(modelName, body, logExtra = {}) {
  const apiUrl = `${getXaiAuth().baseUrl}/responses`;
  const timeoutMs = Number.isFinite(logExtra.timeoutMs) ? logExtra.timeoutMs : API_TIMEOUT_MS;
  const { timeoutMs: _omit, ...requestLogExtra } = logExtra;
  const res = await callApiWithRetry(modelName, apiUrl, body, requestLogExtra, timeoutMs);

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    log.error(`   JSON parse error from ${modelName}:`);
    log.error(`      ${parseErr.message}`);
    throw new Error(`${modelName} API: invalid response (JSON parsing failed)`);
  }

  try {
    logApiResponse(modelName, apiUrl, data, logExtra);
  } catch (err) {
    log.warn(`Failed to write API response log: ${err.message}`);
  }

  if (!data || (!Array.isArray(data.output) && typeof data.output_text !== 'string')) {
    log.error(`   Malformed ${modelName} response (Responses API):`);
    log.error(`      output: ${typeof data?.output} | output_text: ${typeof data?.output_text}`);
    log.error(`      full response: ${JSON.stringify(data)}`);

    if (data?.error) {
      throw new Error(`${modelName} API error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    throw new Error(`${modelName} API: no response received (empty or malformed)`);
  }

  return data;
}

/**
 * Authenticated fetch to xAI with OAuth reload + optional Hermes refresh (GET/POST).
 * Used by TTS, video poll, and other non-Responses endpoints.
 */
async function fetchXaiWithOAuthRetry(url, options = {}, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : API_TIMEOUT_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : MAX_API_RETRIES;
  let forceTokenReload = false;
  let hermesRefreshAttempted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let timer;
    try {
      const { token } = getXaiAuth(forceTokenReload);
      forceTokenReload = false;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const shortErr = errBody.startsWith('<!') ? 'Cloudflare error' : errBody;
        const errMsg = `HTTP ${res.status}: ${shortErr}`;
        if (res.status === 401) forceTokenReload = true;

        if (!XAI_USE_API_KEY && _isOAuthCredentialError(errMsg) && !hermesRefreshAttempted) {
          hermesRefreshAttempted = true;
          try {
            await refreshHermesOAuth();
            forceTokenReload = true;
            continue;
          } catch (refreshErr) {
            log.error(`   Hermes OAuth refresh failed: ${refreshErr.message}`);
          }
        }

        throw new Error(errMsg);
      }

      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isTimeout = err.name === 'AbortError';
      const isRetryable = isTimeout
        || (err.message && /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(err.message))
        || (err.message && /^HTTP (401|429|500|502|503|504)/.test(err.message));
      if (isRetryable && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('xAI authenticated fetch failed');
}

module.exports = {
  callResponsesModel,
  callApiWithRetry,
  logApiRequest,
  logApiResponse,
  fetchXaiWithOAuthRetry,
  isGrokCreditExhaustedError,
  GROK_CREDIT_EXHAUSTED_CODE,
};