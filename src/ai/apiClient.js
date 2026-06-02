// src/ai/apiClient.js
//
// Centralized API client for all LLM calls (Grok via Hermes).
// Provides retry + timeout logic, structured request/response logging
// with PII + base64 redaction, and log directory quota enforcement.
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
const LOG_ENTRY_MAX_BYTES = 1 * 1024 * 1024;       // 1 MB cap per single entry post-redaction
const REDACT_BASE64_KEEP = 64;                      // keep first N chars of each base64 payload
const REDACT_TEXT_KEEP = 4 * 1024;                  // keep first N chars of long text content parts
const crypto = require('crypto');

// -- Redaction helpers -----------------------------------------------------
//
// We log every API request/response to disk for debugging. Without redaction
// these files contain user PII (emails, phone numbers, names), full base64
// of incoming images/audio/video, and command strings that can include paths
// or file contents. The redactor walks the body in-place (on a deep clone)
// and shrinks the heaviest fields without losing the structure needed for
// debugging.

const _EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const _WA_JID_RE = /\b\d{8,15}@(?:c|s)\.us\b/g;
const _PHONE_RE = /\b\+?\d{8,15}\b/g;

function _redactStringPii(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s
    .replace(_EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(_WA_JID_RE, '[REDACTED_JID]')
    .replace(_PHONE_RE, (m) => (m.length >= 8 ? '[REDACTED_PHONE]' : m));
}

function _truncateBase64DataUrl(url) {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  if (!m) return url;
  const head = m[2].slice(0, REDACT_BASE64_KEEP);
  return `data:${m[1]};base64,${head}…[truncated ${m[2].length - head.length} chars]`;
}

function _redactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.includes(';base64,')) {
      return _truncateBase64DataUrl(value);
    }
    let out = value;
    if (out.length > REDACT_TEXT_KEEP) {
      out = out.slice(0, REDACT_TEXT_KEEP) + `…[truncated ${out.length - REDACT_TEXT_KEEP} chars]`;
    }
    return _redactStringPii(out);
  }
  if (Array.isArray(value)) return value.map(_redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _redactValue(value[k]);
    return out;
  }
  return value;
}

function _redactEntry(entry) {
  try {
    return _redactValue(entry);
  } catch {
    return entry;
  }
}

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

function extractAttachmentsFromMessages(messages) {
  const attachments = [];

  if (!Array.isArray(messages)) return attachments;

  messages.forEach((message, index) => {
    if (!message || !Array.isArray(message.content)) return;
    const mediaParts = message.content.filter(part => part && part.type && part.type !== 'text');
    mediaParts.forEach((part, partIndex) => {
      const dataUrl = part.image_url?.url || '';
      let mimetype = null;
      if (typeof dataUrl === 'string') {
        const m = /^data:([^;]+);base64,/.exec(dataUrl);
        if (m) mimetype = m[1];
      }
      attachments.push({
        role: message.role || null,
        messageIndex: index,
        partIndex,
        type: part.type,
        mimetype,
      });
    });
  });

  return attachments;
}

function logApiRequest(modelName, apiUrl, body, extra = {}) {
  try {
    ensureLogDir();
    _enforceLogDirQuota();
    const now = new Date().toISOString();
    const requestAttachments = extractAttachmentsFromMessages(body.messages);
    const entry = _redactEntry({
      timestamp: now,
      model: modelName,
      apiUrl,
      requestBody: body,
      requestAttachments,
      ...extra,
    });
    let serialized = JSON.stringify(entry, null, 2);
    if (serialized.length > LOG_ENTRY_MAX_BYTES) {
      // Defensive truncation: redacted entries should already fit, but very
      // long aggregations (many tool rounds) can still blow past the cap.
      serialized = serialized.slice(0, LOG_ENTRY_MAX_BYTES) +
        `\n... [entry truncated at ${LOG_ENTRY_MAX_BYTES} bytes]`;
    }
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
    const entry = _redactEntry({
      timestamp: now,
      model: modelName,
      apiUrl,
      responseBody,
      ...extra,
    });
    let serialized = JSON.stringify(entry, null, 2);
    if (serialized.length > LOG_ENTRY_MAX_BYTES) {
      serialized = serialized.slice(0, LOG_ENTRY_MAX_BYTES) +
        `\n... [entry truncated at ${LOG_ENTRY_MAX_BYTES} bytes]`;
    }
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
async function callApiWithRetry(modelName, apiUrl, body, apiKey) {
  logApiRequest(modelName, apiUrl, body);
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const startTime = Date.now();
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
      const duration = Date.now() - startTime;

      if (!res.ok) {
        const errBody = await res.text();
        const shortErr = errBody.startsWith('<!') ? 'Cloudflare error' : errBody.substring(0, 500);
        throw new Error(`HTTP ${res.status}: ${shortErr}`);
      }

      log.debug(`   Model: ${modelName} - ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('524'));
      const isNetworkError = err.message && /ECONNRESET|ECONNREFUSED|ERR_NETWORK|timeout|timed out/i.test(err.message);
      const isRetryable = isTimeout || isNetworkError || (err.message && /^HTTP (429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError' ? `Timeout (${API_TIMEOUT_MS / 1000}s)` : err.message;

      if (isRetryable && attempt < MAX_API_RETRIES) {
        const delay = attempt * 3000;
        log.warn(`   API attempt ${attempt}/${MAX_API_RETRIES} failed: ${errMsg} - retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      log.error(`   API error: ${errMsg}`);
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
async function callResponsesModel(modelName, apiUrl, body, apiKey) {
  const res = await callApiWithRetry(modelName, apiUrl, body, apiKey);

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    log.error(`   JSON parse error from ${modelName}:`);
    log.error(`      ${parseErr.message}`);
    throw new Error(`${modelName} API: invalid response (JSON parsing failed)`);
  }

  try {
    logApiResponse(modelName, apiUrl, data);
  } catch (err) {
    log.warn(`Failed to write API response log: ${err.message}`);
  }

  if (!data || (!Array.isArray(data.output) && typeof data.output_text !== 'string')) {
    log.error(`   Malformed ${modelName} response (Responses API):`);
    log.error(`      output: ${typeof data?.output} | output_text: ${typeof data?.output_text}`);
    log.error(`      full response: ${JSON.stringify(data).substring(0, 500)}`);

    if (data?.error) {
      throw new Error(`${modelName} API error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    throw new Error(`${modelName} API: no response received (empty or malformed)`);
  }

  return data;
}

module.exports = { callResponsesModel, logApiRequest, logApiResponse };
