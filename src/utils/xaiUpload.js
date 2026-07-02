// src/utils/xaiUpload.js
//
// Public file hosting for xAI ingestion (input_file / input_image and
// image/video reference URLs). Files are uploaded to tmpfile.link and the
// returned downloadLink is handed to xAI, which fetches it server-side.
//
// Upload results are cached per absolute path (keyed on mtime + size) so a
// history file referenced on every turn is uploaded once per cache window
// instead of once per call.
//
// The GemiX attachment tunnel (tempFileServer + Caddy) is NOT used for xAI:
// it only serves temporary download links sent to end users.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('XaiUpload');

const UPLOAD_URL = 'https://tmpfile.link/api/upload';
const UPLOAD_TIMEOUT_MS = 60_000;
// Re-upload window. tmpfile.link links live much longer, but xAI fetches the
// URL right after the request, so a conservative window keeps links fresh.
const URL_CACHE_TTL_MS = 60 * 60 * 1000;

// Map<absPath, { mtimeMs, size, url, uploadedAt }>
const _urlCache = new Map();

function _cacheGet(absPath, stat) {
  const hit = _urlCache.get(absPath);
  if (!hit) return null;
  if (hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) return null;
  if (Date.now() - hit.uploadedAt > URL_CACHE_TTL_MS) return null;
  return hit.url;
}

async function _uploadBuffer(buffer, displayName, mimetype) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
  form.append('file', blob, path.basename(displayName || 'file'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`upload failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    const url = data && typeof data.downloadLink === 'string' ? data.downloadLink : null;
    if (!url) {
      throw new Error('upload response has no downloadLink');
    }
    return url;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`upload timeout (${UPLOAD_TIMEOUT_MS / 1000}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload a file on disk and return its public HTTPS URL for xAI ingestion.
 * Cached per path while the file is unchanged.
 *
 * @param {string} absPath - Absolute path of the file to expose.
 * @param {string} displayName - Filename to expose in the URL.
 * @param {string} [mimetype]
 * @returns {Promise<string>} Public HTTPS URL.
 */
async function uploadFileForXai(absPath, displayName, mimetype, opts = {}) {
  const stat = fs.statSync(absPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`cannot upload "${displayName}": empty file or not a file`);
  }
  const forceRefresh = opts.forceRefresh === true;
  if (!forceRefresh) {
    const cached = _cacheGet(absPath, stat);
    if (cached) return cached;
  } else {
    _urlCache.delete(absPath);
  }

  const buffer = fs.readFileSync(absPath);
  const url = await _uploadBuffer(buffer, displayName, mimetype);
  _urlCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, url, uploadedAt: Date.now() });
  log.info(`Uploaded for xAI: ${path.basename(displayName)} (${stat.size} bytes)${forceRefresh ? ' (refreshed)' : ''}`);
  return url;
}

/** Drop all cached tmpfile.link URLs (e.g. before re-uploading after xAI fetch failure). */
function clearXaiUploadCache() {
  _urlCache.clear();
}

module.exports = { uploadFileForXai, clearXaiUploadCache };
