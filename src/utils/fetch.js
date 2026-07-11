// src/utils/fetch.js
//
// Wrapper around native fetch that adds reliable timeout handling and
// optional automatic admin notification on failures. Used for external
// service calls throughout the bot.

const fs = require('fs');
const path = require('path');
const { FETCH_TIMEOUT_MS } = require('../config/constants');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('./adminNotifier');

function _downloadTimeoutMs(maxBytes, optsTimeout) {
  if (Number.isFinite(optsTimeout)) return optsTimeout;
  const minBytesPerSec = 256 * 1024;
  return Math.max(FETCH_TIMEOUT_MS, Math.ceil(maxBytes / minBytesPerSec) * 1000);
}

/**
 * Read a fetch response body with a running byte cap (safe when Content-Length is absent).
 * @param {Response} res
 * @param {number} maxBytes
 * @param {number} timeoutMs
 * @param {string|null} [destPath] - When set, write to disk instead of buffering.
 * @returns {Promise<Buffer|number>} Buffer or byte count written.
 */
async function _consumeResponseBodyCapped(res, maxBytes, timeoutMs, destPath = null) {
  if (!res.body) throw new Error('No response body');
  const reader = res.body.getReader();
  let received = 0;
  const chunks = destPath ? null : [];
  let stream = null;
  if (destPath) {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(destPath);
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (Date.now() > deadline) {
        throw new Error(`Body read timeout (${timeoutMs / 1000}s)`);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      received += value.length;
      if (received > maxBytes) {
        throw new Error(`File too large (${received} bytes, max ${maxBytes})`);
      }
      const buf = Buffer.from(value);
      if (stream) stream.write(buf);
      else chunks.push(buf);
    }
  } catch (err) {
    if (stream) {
      stream.destroy();
      try { if (destPath && fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    if (stream) {
      await new Promise((resolve, reject) => {
        stream.end((endErr) => (endErr ? reject(endErr) : resolve()));
      });
    }
  }

  if (received === 0) throw new Error('Download returned an empty body.');
  return destPath ? received : Buffer.concat(chunks);
}

async function readResponseBodyWithTimeout(readPromise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Body read timeout (${timeoutMs / 1000}s)`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([readPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
  const timeoutMs = _downloadTimeoutMs(maxBytes, opts.timeoutMs);
  const res = await fetchWithTimeout(clean, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': '*/*',
    },
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} (${clean.slice(0, 120)})`);
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new Error(`File too large (${declared} bytes, max ${maxBytes})`);
  }
  const buffer = await _consumeResponseBodyCapped(res, maxBytes, timeoutMs);
  const mimetype = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  let filename = 'file';
  try {
    const segment = decodeURIComponent(new URL(clean).pathname.split('/').filter(Boolean).pop() || '');
    if (segment) filename = segment;
  } catch { /* keep fallback */ }
  return { buffer, mimetype, filename };
}

function _filenameFromPublicUrl(url) {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return segment || 'file';
  } catch {
    return 'file';
  }
}

/**
 * Download a public HTTP(S) file to disk with a hard size cap (incremental read).
 * Used when the in-memory cap is exceeded but the file should still be delivered
 * via temp download link.
 *
 * @param {string} url
 * @param {string} destPath - Absolute path to write.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=104857600] - 100 MB default cap.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ filePath: string, mimetype: string, filename: string, size: number }>}
 */
async function downloadPublicFileToDisk(url, destPath, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 100 * 1024 * 1024;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    throw new Error(`Invalid URL: "${String(url).slice(0, 120)}"`);
  }
  if (typeof destPath !== 'string' || !destPath.trim()) {
    throw new Error('destPath is required');
  }
  const clean = url.trim();
  const timeoutMs = _downloadTimeoutMs(maxBytes, opts.timeoutMs);
  const res = await fetchWithTimeout(clean, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': '*/*',
    },
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} (${clean.slice(0, 120)})`);
  }
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new Error(`File too large (${declared} bytes, max ${maxBytes})`);
  }
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const size = await _consumeResponseBodyCapped(res, maxBytes, timeoutMs, destPath);

  const mimetype = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  return {
    filePath: destPath,
    mimetype,
    filename: _filenameFromPublicUrl(clean),
    size,
  };
}

module.exports = {
  fetchWithTimeout,
  fetchExternal,
  downloadPublicFile,
  downloadPublicFileToDisk,
  readResponseBodyWithTimeout,
  filenameFromPublicUrl: _filenameFromPublicUrl,
};
