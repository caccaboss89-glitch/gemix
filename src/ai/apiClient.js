// src/ai/apiClient.js
//
// Centralized API client for all LLM calls (Grok via Hermes).
// Provides retry + timeout logic, structured request/response logging,
// and log directory quota enforcement.
// Responses API path (callResponsesModel).

const fs = require('fs');
const path = require('path');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { MAX_API_RETRIES, API_TIMEOUT_MS } = require('../config/constants');
const { createLogger } = require('../utils/logger');

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

/**
 * Unified API client with retry and timeout logic.
 * @param {string} modelName - Model name for logging (e.g., 'Grok')
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @param {string} apiKey - API key for authentication
 * @returns {Promise<Response>} The raw fetch Response
 */
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

async function callApiWithRetry(modelName, apiUrl, body, apiKey, logExtra = {}) {
  logApiRequest(modelName, apiUrl, body, logExtra);
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    let timer;
    const attemptStarted = Date.now();
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
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
      const isRetryable = isTimeout || isNetworkError || (err.message && /^HTTP (429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError'
        ? `Timeout (request aborted after ${API_TIMEOUT_MS / 1000}s)`
        : err.message;

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
      await notifyAdmin(`API (${modelName})`, `Error after ${attempt} attempt(s): ${errMsg}`);
      throw new Error(`${modelName} API unreachable after ${attempt} attempt(s): ${errMsg}${ADMIN_NOTIFIED_SUFFIX}`);
    }
  }
}

/**
 * Call an AI model on the xAI Responses API (`/v1/responses`) and return
 * the parsed raw payload (not yet adapted to chat-completion shape).
 *
 * Callers (e.g. aiProvider.callAI for the main brain, webXSearch for the
 * research team) are in charge of translating `output[]` into whatever they
 * need. For the main brain we use `responsesToAssistantMessage` from
 * responsesAdapter.js to reach the chat-style message the handler expects.
 *
 * @param {string} modelName
 * @param {string} apiUrl - Full URL to /v1/responses
 * @param {object} body
 * @param {string} apiKey
 * @returns {Promise<object>} The full parsed JSON body
 */
async function callResponsesModel(modelName, apiUrl, body, apiKey, logExtra = {}) {
  const res = await callApiWithRetry(modelName, apiUrl, body, apiKey, logExtra);

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

module.exports = { callResponsesModel, logApiRequest, logApiResponse };