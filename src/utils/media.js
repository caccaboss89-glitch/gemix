const { SUPPORTED_MEDIA, UNSUPPORTED_MEDIA } = require('../config/constants');

function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

function isUnsupportedMedia(type) {
  return UNSUPPORTED_MEDIA.includes(type);
}

/**
 * Convert media to base64 content part for the AI API (aimlapi.com OpenAI-compatible format).
 * All media types use image_url with data URI — the MIME type tells Gemini the actual content type.
 * @param {Buffer} buffer
 * @param {string} mimetype - e.g. 'image/jpeg', 'audio/ogg', 'application/pdf'
 * @returns {object} Content part for the messages array
 */
function mediaToContentPart(buffer, mimetype) {
  // Strip parameters (e.g. 'audio/ogg; codecs=opus' → 'audio/ogg')
  const cleanMime = mimetype.split(';')[0].trim();
  const base64 = buffer.toString('base64');
  return {
    type: 'image_url',
    image_url: { url: `data:${cleanMime};base64,${base64}` },
  };
}

/**
 * Build a filename descriptor for unsupported or any media in history
 */
function mediaTag(filename, mimetype) {
  if (filename) return `[${filename}]`;
  const ext = (mimetype || '').split('/')[1] || 'file';
  return `[file.${ext}]`;
}

module.exports = { isSupportedMedia, isUnsupportedMedia, mediaToContentPart, mediaTag };
