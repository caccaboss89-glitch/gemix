const fs = require('fs');
const path = require('path');
const { notifyAdmin } = require('../utils/adminNotifier');
const { MAX_API_RETRIES, API_TIMEOUT_MS } = require('../config/constants');
const { createLogger } = require('../utils/logger');

const log = createLogger('API');
const apiLogFile = path.resolve(__dirname, '..', 'logs', 'api-request-log.txt');

function ensureLogDir() {
  const dir = path.dirname(apiLogFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function logApiRequest(modelName, apiUrl, body) {
  try {
    ensureLogDir();
    const entry = {
      timestamp: new Date().toISOString(),
      model: modelName,
      apiUrl,
      requestBody: body,
    };
    fs.appendFileSync(apiLogFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.warn(`Impossibile scrivere log API su file: ${err.message}`);
  }
}

/**
 * Unified API client with retry and timeout logic.
 * Used by both Gemini and Grok to ensure consistent behavior.
 * @param {string} modelName - Model name for logging (e.g., 'Gemini', 'Grok')
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
          'Authorization': `Bearer ${process.env.API_KEY || require('../config/env').API_KEY}`,
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
    const responseLogFile = path.resolve(__dirname, '..', 'logs', 'api-response-log.txt');
    const entry = {
      timestamp: new Date().toISOString(),
      model: modelName,
      apiUrl,
      responseBody: data,
    };
    fs.appendFileSync(responseLogFile, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.warn(`Impossibile scrivere log API response su file: ${err.message}`);
  }

  if (!data.choices || !data.choices[0]) {
    throw new Error(`${modelName} API: nessuna risposta ricevuta`);
  }
  return data.choices[0].message;
}

module.exports = { callApiWithRetry, callModel };
