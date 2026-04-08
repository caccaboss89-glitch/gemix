const { FETCH_TIMEOUT_MS } = require('../config/constants');
const { notifyAdmin } = require('./adminNotifier');

/**
 * Fetch with automatic timeout via AbortController.
 * Wraps native fetch with a configurable timeout (default: FETCH_TIMEOUT_MS from constants).
 * @param {string} url - The URL to fetch
 * @param {object} [options={}] - Standard fetch options (method, headers, body, etc.)
 * @param {number} [timeoutMs] - Custom timeout in milliseconds (default: FETCH_TIMEOUT_MS)
 * @returns {Promise<Response>} The fetch Response object
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timeout (${timeoutMs / 1000}s) raggiunto per ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with timeout + automatic admin notification on error.
 * Useful for external service calls (GitHub, TTS, SearXNG, etc.)
 * @param {string} url - The URL to fetch
 * @param {object} [options={}] - Standard fetch options
 * @param {string} [source] - Error source label for admin notification (e.g., 'SearXNG')
 * @param {number} [timeoutMs] - Custom timeout in ms
 * @returns {Promise<Response>} The fetch Response object
 */
async function fetchExternal(url, options = {}, source = null, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(url, options, timeoutMs);
    if (!res.ok && source) {
      await notifyAdmin(source, `Errore HTTP ${res.status}`);
    }
    return res;
  } catch (err) {
    if (source) {
      await notifyAdmin(source, err.message);
    }
    throw err;
  }
}

module.exports = { fetchWithTimeout, fetchExternal };
