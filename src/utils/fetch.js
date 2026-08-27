// src/utils/fetch.js
//
// Wrapper around native fetch that adds reliable timeout handling and
// optional automatic admin notification on failures. Used for external
// service calls throughout the bot.

import constants from '../config/constants.js';
import { buildAdminNotificationNote, notifyAdminDetailed } from './adminNotifier.js';
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
  let res;
  try {
    res = await fetchWithTimeout(url, options, timeoutMs);
  } catch (err) {
    if (source) {
      const notification = await notifyAdminDetailed(source, err.message);
      throw new Error(`${err.message}${buildAdminNotificationNote(notification)}`, { cause: err });
    }
    throw err;
  }
  if (!res.ok && source) {
    const errMsg = `HTTP Error ${res.status}`;
    const notification = await notifyAdminDetailed(source, errMsg);
    throw new Error(`${errMsg}${buildAdminNotificationNote(notification)}`);
  }
  return res;
}

/**
 * Download a public HTTP(S) file into memory with a hard size cap.
 * Used when the program itself has to fetch a remote file (image search hits,
 * generated media, Discord attachments). Every DNS target and redirect is
 * restricted to globally routable addresses.
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
    response.destroy();
    throw new Error(`Download failed: HTTP ${response.statusCode} (${clean.slice(0, 120)})`);
  }
  const declared = Number(_header(response, 'content-length') || 0);
  if (declared > maxBytes) {
    // Dropped rather than drained: nothing here is going to be read, and on a
    // home line downloading a body only to discard it is the expensive option.
    response.destroy();
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

export {
  fetchWithTimeout,
  fetchExternal,
  downloadPublicFile,
  readResponseBodyWithTimeout
};
