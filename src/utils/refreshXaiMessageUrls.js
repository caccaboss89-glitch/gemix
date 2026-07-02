// src/utils/refreshXaiMessageUrls.js
//
// When xAI rejects a request because a tmpfile.link URL expired, rebuild
// fresh public URLs from the on-disk source files still referenced in messages.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const { extractAttachmentTagPaths } = require('./media');
const { mimeForExtension } = require('../config/mimeExtensions');
const { uploadFileForXai } = require('./xaiUpload');
const {
  classifyAiFileDelivery,
  DELIVERY_MODE,
  resolveHistoryAbsPath,
} = require('./aiFileDelivery');

const log = createLogger('XaiUrlRefresh');

function isXaiFileDownloadError(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  return /failed to download the file from the provided URL|could not be retrieved/i.test(errMsg);
}

function _extOf(name) {
  return path.extname(name || '').toLowerCase();
}

function _partHasUrl(part) {
  if (!part || typeof part !== 'object') return false;
  return (part.type === 'input_file' && part.file_url)
    || (part.type === 'input_image' && part.image_url)
    || (part.type === 'image_url' && part.image_url?.url);
}

function _resolveAbsPathForPart(part, storageId, tagPaths, usedTagIndices) {
  let absPath = typeof part._xaiSourcePath === 'string' ? part._xaiSourcePath : null;
  if (absPath && fs.existsSync(absPath)) return absPath;

  if (storageId && tagPaths.length > 0) {
    const sourceHint = absPath ? path.basename(absPath) : null;
    for (let i = 0; i < tagPaths.length; i++) {
      if (usedTagIndices.has(i)) continue;
      const tagPath = tagPaths[i];
      const tagBase = path.basename(tagPath);
      if (sourceHint && tagBase !== sourceHint) continue;
      const candidate = resolveHistoryAbsPath(storageId, tagPath);
      if (candidate) {
        usedTagIndices.add(i);
        return candidate;
      }
    }
    if (!sourceHint) {
      for (let i = 0; i < tagPaths.length; i++) {
        if (usedTagIndices.has(i)) continue;
        const candidate = resolveHistoryAbsPath(storageId, tagPaths[i]);
        if (candidate) {
          usedTagIndices.add(i);
          return candidate;
        }
      }
    }
  }

  if (absPath && fs.existsSync(absPath)) return absPath;
  return null;
}

async function _refreshFilePart(part, absPath, displayName) {
  const mimetype = mimeForExtension(_extOf(displayName), 'application/octet-stream');
  const mode = classifyAiFileDelivery(displayName, mimetype);
  const url = await uploadFileForXai(absPath, displayName, mimetype, { forceRefresh: true });
  part._xaiSourcePath = absPath;

  if (part.type === 'input_file' && typeof part.file_url === 'string') {
    part.file_url = url;
    return true;
  }
  if (part.type === 'input_image' && typeof part.image_url === 'string') {
    part.image_url = url;
    return true;
  }
  if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
    part.image_url.url = url;
    return true;
  }
  if (mode === DELIVERY_MODE.IMAGE) {
    part.type = 'input_image';
    part.image_url = url;
    delete part.file_url;
    return true;
  }
  part.type = 'input_file';
  part.file_url = url;
  delete part.image_url;
  return true;
}

/**
 * Re-upload history / transcript files referenced in chat messages and patch
 * stale tmpfile.link URLs in place.
 *
 * @param {Array} messages - handler messages array (mutated in place).
 * @param {string|null} storageId - history storage id for this conversation.
 * @returns {Promise<number>} count of URLs refreshed.
 */
async function refreshXaiUrlsInMessages(messages, storageId) {
  if (!Array.isArray(messages)) return 0;

  let count = 0;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    const tagPaths = [];
    for (const part of msg.content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        for (const p of extractAttachmentTagPaths(part.text)) tagPaths.push(p);
      }
    }

    const usedTagIndices = new Set();
    for (const part of msg.content) {
      if (!_partHasUrl(part)) continue;

      const absPath = _resolveAbsPathForPart(part, storageId, tagPaths, usedTagIndices);
      if (!absPath || !fs.existsSync(absPath)) continue;

      try {
        const displayName = path.basename(absPath);
        if (await _refreshFilePart(part, absPath, displayName)) count += 1;
      } catch (err) {
        log.warn(`Could not refresh xAI URL for ${path.basename(absPath)}: ${err.message}`);
      }
    }
  }

  if (count > 0) {
    log.info(`Refreshed ${count} stale xAI file URL(s)${storageId ? ` for storageId=${storageId}` : ''}`);
  }
  return count;
}

module.exports = { isXaiFileDownloadError, refreshXaiUrlsInMessages };
