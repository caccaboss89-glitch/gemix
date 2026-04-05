const fs = require('fs');
const path = require('path');
const { notifyAdmin } = require('../utils/adminNotifier');
const { MAX_API_RETRIES, API_TIMEOUT_MS } = require('../config/constants');
const { API_KEY } = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('API');
const apiLogDir = path.resolve(__dirname, '..', 'logs');

function ensureLogDir() {
  if (!fs.existsSync(apiLogDir)) {
    fs.mkdirSync(apiLogDir, { recursive: true });
  }
}

function _getLogFilePath(prefix, timestamp) {
  const sanitized = timestamp.replace(/[:.]/g, '-');
  return path.join(apiLogDir, `${prefix}-${sanitized}.json`);
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
    log.warn(`Impossibile scrivere log API su file: ${err.message}`);
    return null;
  }
}

/**
 * Unified API client with retry and timeout logic.
 * @param {string} modelName - Model name for logging (e.g., 'Gemini')
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @returns {Promise<Response>} The raw fetch Response
 */
async function callApiWithRetry(modelName, apiUrl, body) {
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      logApiRequest(modelName, apiUrl, body);
      const startTime = Date.now();
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.API_KEY || API_KEY}`,
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

      log.debug(`   Modello: ${modelName} - ${duration}ms${attempt > 1 ? ` (tentativo ${attempt})` : ''}`);
      return res;
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('524'));
      const isRetryable = isTimeout || (err.message && /^HTTP (429|500|502|503|504)/.test(err.message));
      const errMsg = err.name === 'AbortError' ? 'Timeout (60s)' : err.message;

      if (isRetryable && attempt < MAX_API_RETRIES) {
        const delay = attempt * 3000;
        log.warn(`   ⚠️ API tentativo ${attempt}/${MAX_API_RETRIES} fallito: ${errMsg} — retry in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      log.error(`   ❌ API Error: ${errMsg}`);
      await notifyAdmin(`AIMLAPI (${modelName})`, `Errore dopo ${attempt} tentativi: ${errMsg}`);
      throw new Error(`${modelName} API non raggiungibile dopo ${attempt} tentativ${attempt > 1 ? 'i' : 'o'}: ${errMsg}`);
    }
  }
}

/**
 * Call an AI model and return the parsed assistant message.
 * Wraps callApiWithRetry + response parsing in one call.
 * @param {string} modelName - Display name for logging
 * @param {string} apiUrl - Full API endpoint URL
 * @param {object} body - Request body
 * @returns {Promise<object>} The assistant message object from the API response
 */
async function callModel(modelName, apiUrl, body) {
  const res = await callApiWithRetry(modelName, apiUrl, body);
  const data = await res.json();

  try {
    ensureLogDir();
    const now = new Date().toISOString();
    const responseLogFile = _getLogFilePath('api-response', now);
    const entry = {
      timestamp: now,
      model: modelName,
      apiUrl,
      responseBody: data,
    };
    fs.writeFileSync(responseLogFile, JSON.stringify(entry, null, 2));
  } catch (err) {
    log.warn(`Impossibile scrivere log API response su file: ${err.message}`);
  }

  if (!data.choices || !data.choices[0]) {
    throw new Error(`${modelName} API: nessuna risposta ricevuta`);
  }
  return data.choices[0].message;
}

module.exports = { callApiWithRetry, callModel };
