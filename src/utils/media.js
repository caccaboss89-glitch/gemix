// src/utils/media.js
//
// Helpers for attachment tags and supported WhatsApp media types.

const { SUPPORTED_MEDIA } = require('../config/constants');

function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

/**
 * Build a standardized attachment tag for AI context (always English).
 */
function buildAttachmentTag(syncedPath, fallbackName) {
  if (syncedPath) {
    const clean = syncedPath.startsWith('history/') ? syncedPath.slice('history/'.length) : syncedPath;
    return `[Attachment: ${clean}]`;
  }
  return `[Attachment (expired): ${fallbackName || 'file'}]`;
}

function extractAttachmentTagPaths(text) {
  const paths = [];
  if (typeof text !== 'string' || text.length === 0) return paths;
  const re = /\[Attachment(?:\s*\(expired\))?:\s*([^\]\n\r]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (raw) paths.push(raw);
  }
  return paths;
}

module.exports = {
  isSupportedMedia,
  buildAttachmentTag,
  extractAttachmentTagPaths,
};