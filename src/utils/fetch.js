// src/utils/fetch.js
//
// Wrapper around native fetch that adds reliable timeout handling and
// optional automatic admin notification on failures. Used for external
// service calls throughout the bot.

const { FETCH_TIMEOUT_MS } = require('../config/constants');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('./adminNotifier');

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
      throw new Error(`Timeout (${timeoutMs / 1000}s) reached for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with timeout + automatic admin notification on error.
 * Useful for external service calls (GitHub, TTS, image search, etc.)
 * @param {string} url - The URL to fetch
 * @param {object} [options={}] - Standard fetch options
 * @param {string} [source] - Error source label for admin notification (e.g., 'GitHub')
 * @param {number} [timeoutMs] - Custom timeout in ms
 * @returns {Promise<Response>} The fetch Response object
 */
async function fetchExternal(url, options = {}, source = null, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(url, options, timeoutMs);
    if (!res.ok && source) {
      const errMsg = `HTTP Error ${res.status}`;
      await notifyAdmin(source, errMsg);
      throw new Error(`${errMsg}${ADMIN_NOTIFIED_SUFFIX}`);
    }
    return res;
  } catch (err) {
    if (source) {
      await notifyAdmin(source, err.message);
      const notifiedErr = new Error(`${err.message}${ADMIN_NOTIFIED_SUFFIX}`);
      throw notifiedErr;
    }
    throw err;
  }
}

/**
 * Download a public HTTP(S) file into memory with a hard size cap.
 * Used when the model references files by URL (web/X search results,
 * delivery attachments, build inputs). SSRF surface accepted: URLs come
 * from model output / search results, mirroring the previous research
 * image download path.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=62914560] - 60 MB default cap.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ buffer: Buffer, mimetype: string, filename: string }>}
 */
async function downloadPublicFile(url, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 60 * 1024 * 1024;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    throw new Error(`Invalid URL: "${String(url).slice(0, 120)}"`);
  }
  const clean = url.trim();
  const res = await fetchWithTimeout(clean, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': '*/*',
    },
  }, opts.timeoutMs);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} (${clean.slice(0, 120)})`);
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new Error(`File too large (${declared} bytes, max ${maxBytes})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error('Download returned an empty body.');
  if (buffer.length > maxBytes) {
    throw new Error(`File too large (${buffer.length} bytes, max ${maxBytes})`);
  }
  const mimetype = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  let filename = 'file';
  try {
    const segment = decodeURIComponent(new URL(clean).pathname.split('/').filter(Boolean).pop() || '');
    if (segment) filename = segment;
  } catch { /* keep fallback */ }
  return { buffer, mimetype, filename };
}

module.exports = { fetchWithTimeout, fetchExternal, downloadPublicFile };
