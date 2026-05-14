// src/ai/apiClient.js
const fs = require('fs');
const path = require('path');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { MAX_API_RETRIES, API_TIMEOUT_MS } = require('../config/constants');
const { createLogger } = require('../utils/logger');

const log = createLogger('API');
const apiLogDir = path.resolve(__dirname, '..', 'logs');
const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOG_CLEANUP_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const crypto = require('crypto');

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
    const now = new Date().toISOString();
    const requestAttachments = extractAttachmentsFromMessages(body.messages);
    const entry = {
      timestamp: now,
      model: modelName,
      apiUrl,
      requestBody: body,
      requestAttachments,
      ...extra,
    };
    const filePath = _getLogFilePath('api-request', now);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
    return filePath;
  } catch (err) {
    log.warn(`Failed to write API request log: ${err.message}`);
    return null;
  }
}

function logApiResponse(modelName, apiUrl, responseBody, extra = {}) {
  try {
    ensureLogDir();
    const now = new Date().toISOString();
    const responseLogFile = _getLogFilePath('api-response', now);
    const entry = {
      timestamp: now,
      model: modelName,
      apiUrl,
      responseBody,
      ...extra,
    };
    fs.writeFileSync(responseLogFile, JSON.stringify(entry, null, 2));
    return responseLogFile;
  } catch (err) {
    log.warn(`Failed to write API response log: ${err.message}`);
    return null;
  }
}

/**
 * Unified API client with retry and timeout logic.
 * @param {string} modelName - Model name for logging (e.g., 'Gemini', 'Qwen')
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
        log.warn(`   ⚠️ API attempt ${attempt}/${MAX_API_RETRIES} failed: ${errMsg} — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      log.error(`   ❌ API error: ${errMsg}`);
      await notifyAdmin(`API (${modelName})`, `Error after ${attempt} attempt(s): ${errMsg}`);
      throw new Error(`${modelName} API unreachable after ${attempt} attempt(s): ${errMsg}${ADMIN_NOTIFIED_SUFFIX}`);
    }
  }
}

/**
 * Call an AI model and return the parsed assistant message.
 * Wraps callApiWithRetry + response parsing in one call.
 * @param {string} modelName - Display name for logging
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @param {string} apiKey - API key for authentication
 * @returns {Promise<object>} The assistant message object from the API response
 */
async function callModel(modelName, apiUrl, body, apiKey) {
  const res = await callApiWithRetry(modelName, apiUrl, body, apiKey);
  
  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    log.error(`   ⚠️ JSON parse error from ${modelName}:`);
    log.error(`      ${parseErr.message}`);
    throw new Error(`${modelName} API: invalid response (JSON parsing failed)`);
  }

  try {
    logApiResponse(modelName, apiUrl, data);
  } catch (err) {
    log.warn(`Failed to write API response log: ${err.message}`);
  }

  if (!data.choices || !data.choices[0]) {
    log.error(`   ⚠️ Malformed ${modelName} response:`);
    log.error(`      choices: ${JSON.stringify(data.choices)}`);
    log.error(`      full response: ${JSON.stringify(data).substring(0, 500)}`);
    
    // If it's an error response, include details
    if (data.error) {
      throw new Error(`${modelName} API error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    
    throw new Error(`${modelName} API: no response received (empty or malformed)`);
  }
  return data.choices[0].message;
}

module.exports = { callModel, logApiRequest, logApiResponse };
