// src/utils/fetch.js
//
// Wrapper around native fetch that adds reliable timeout handling and
// optional automatic admin notification on failures. Used for external
// service calls throughout the bot.

import fs from 'fs';
import path from 'path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import constants from '../config/constants.js';
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from './adminNotifier.js';
import { openPublicHttp } from './publicHttp.js';
import { signalWithTimeout } from './turnBudget.js';

function _downloadTimeoutMs(maxBytes, optsTimeout) {
  if (Number.isFinite(optsTimeout)) return optsTimeout;
  const minBytesPerSec = 256 * 1024;
  return Math.max(constants.FETCH_TIMEOUT_MS, Math.ceil(maxBytes / minBytesPerSec) * 1000);
}

function _header(response, name) {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function _consumePublicBody(response, maxBytes, signal) {
  let received = 0;
  const chunks = [];
  for await (const raw of response) {
    if (signal?.aborted) throw signal.reason || new Error('Download aborted.');
    const chunk = Buffer.from(raw);
    received += chunk.length;
    if (received > maxBytes) {
      response.destroy();
      throw new Error(`File too large (${received} bytes, max ${maxBytes})`);
    }
    chunks.push(chunk);
  }
  if (received === 0) throw new Error('Download returned an empty body.');
  return Buffer.concat(chunks, received);
}

async function _consumePublicBodyToDisk(response, maxBytes, destPath, signal) {
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        callback(new Error(`File too large (${received} bytes, max ${maxBytes})`));
        return;
      }
      callback(null, chunk);
    }
  });
  const stream = fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(response, limiter, stream, { signal });
    if (received === 0) throw new Error('Download returned an empty body.');
    return received;
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch { /* absent or never created */ }
    throw err;
  }
}

async function readResponseBodyWithTimeout(readPromise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Body read timeout (${timeoutMs / 1000}s)`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([readPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch with automatic timeout, preserving any caller cancellation.
 * Wraps native fetch with a configurable timeout (default: constants.FETCH_TIMEOUT_MS from constants).
 * @param {string} url - The URL to fetch
 * @param {object} [options={}] - Standard fetch options (method, headers, body, etc.)
 * @param {number} [timeoutMs] - Custom timeout in milliseconds (default: constants.FETCH_TIMEOUT_MS)
 * @returns {Promise<Response>} The fetch Response object
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = constants.FETCH_TIMEOUT_MS) {
  const callerSignal = options.signal || null;
  const operationSignal = signalWithTimeout(callerSignal, timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: operationSignal });
    return res;
  } catch (err) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason || err;
    }
    if (operationSignal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`Timeout (${timeoutMs / 1000}s) reached for ${url}`);
    }
    throw err;
  }
}

/**
 * Fetch with timeout + automatic admin notification on error.
 * Useful for external service calls (GitHub, TTS, etc.)
 * @param {string} url - The URL to fetch
 * @param {object} [options={}] - Standard fetch options
 * @param {string} [source] - Error source label for admin notification (e.g., 'GitHub')
 * @param {number} [timeoutMs] - Custom timeout in ms
 * @returns {Promise<Response>} The fetch Response object
 */
async function fetchExternal(url, options = {}, source = null, timeoutMs = constants.FETCH_TIMEOUT_MS) {
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
 * Used when the model references files by URL (web/X search results and
 * delivery attachments). Every DNS target and redirect is restricted to
 * globally routable addresses.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=62914560] - 60 MB default cap.
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ buffer: Buffer, mimetype: string, filename: string }>}
 */
async function downloadPublicFile(url, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 60 * 1024 * 1024;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
    throw new Error(`Invalid URL: "${String(url).slice(0, 120)}"`);
  }
  const clean = url.trim();
  const timeoutMs = _downloadTimeoutMs(maxBytes, opts.timeoutMs);
  const operationSignal = signalWithTimeout(opts.signal || null, timeoutMs);
  const { response, url: finalUrl } = await openPublicHttp(clean, {
    signal: operationSignal,
    timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Download failed: HTTP ${response.statusCode} (${clean.slice(0, 120)})`);
  }
  const declared = Number(_header(response, 'content-length') || 0);
  if (declared > maxBytes) {
    response.resume();
    throw new Error(`File too large (${declared} bytes, max ${maxBytes})`);
  }
  const buffer = await _consumePublicBody(response, maxBytes, operationSignal);
  const mimetype = (_header(response, 'content-type') || 'application/octet-stream').split(';')[0].trim();
  const filename = _filenameFromPublicUrl(finalUrl.href);
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
 * @param {AbortSignal} [opts.signal]
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
  const operationSignal = signalWithTimeout(opts.signal || null, timeoutMs);
  const { response, url: finalUrl } = await openPublicHttp(clean, {
    signal: operationSignal,
    timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Download failed: HTTP ${response.statusCode} (${clean.slice(0, 120)})`);
  }
  const declared = Number(_header(response, 'content-length') || 0);
  if (declared > maxBytes) {
    response.resume();
    throw new Error(`File too large (${declared} bytes, max ${maxBytes})`);
  }
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const size = await _consumePublicBodyToDisk(response, maxBytes, destPath, operationSignal);

  const mimetype = (_header(response, 'content-type') || 'application/octet-stream').split(';')[0].trim();
  return {
    filePath: destPath,
    mimetype,
    filename: _filenameFromPublicUrl(finalUrl.href),
    size
  };
}

export {
  fetchWithTimeout,
  fetchExternal,
  downloadPublicFile,
  downloadPublicFileToDisk,
  readResponseBodyWithTimeout, _filenameFromPublicUrl as filenameFromPublicUrl

};
