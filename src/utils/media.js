// src/utils/media.js
//
// Helpers for supported WhatsApp media types and attachment-tag parsing.

import constants from '../config/constants.js';

function isSupportedMedia(type) {
  return constants.SUPPORTED_MEDIA.includes(type);
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

export {
  isSupportedMedia,
  extractAttachmentTagPaths
};
