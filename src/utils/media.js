// src/utils/media.js
//
// Helpers for attachment tags and supported WhatsApp media types.

const { SUPPORTED_MEDIA } = require('../config/constants');

function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

/**
 * Build a standardized attachment tag for AI context (always English).
 * Uses the on-disk history filename when synced; otherwise the resolved display name.
 * "(expired)" is never used — missing sync only means the file was not persisted yet;
 * ingress still uploads via fetchBuffer when possible.
 */
function buildAttachmentTag(syncedPath, fallbackName) {
  const name = syncedPath
    ? (syncedPath.startsWith('history/') ? syncedPath.slice('history/'.length) : syncedPath)
    : (fallbackName || 'file');
  return `[Attachment: ${name}]`;
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
