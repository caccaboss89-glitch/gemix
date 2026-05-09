// src/utils/text.js
/**
 * Sanitize a string for use as a filename.
 * Removes special chars, collapses whitespace to underscores, trims length.
 * @param {string} text - The text to sanitize
 * @param {number} [maxLen=80] - Maximum filename length (before extension)
 * @returns {string} Sanitized filename-safe string
 */
function sanitizeFilename(text, maxLen = 80) {
  return (text || 'file')
    .replace(/[^a-zA-Z0-9àèéìòù.\s_-]/gi, '')
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, maxLen) || 'file';
}

const VOICE_TAGS_INLINE_RE = /\[(pause|long-pause|hum-tune|laugh|chuckle|giggle|cry|tsk|tongue-click|lip-smack|breath|inhale|exhale|sigh)\]/gi;
const VOICE_TAGS_WRAP_RE = /<\/?(?:soft|whisper|loud|build-intensity|decrease-intensity|higher-pitch|lower-pitch|slow|fast|sing-song|singing|laugh-speak|emphasis)>/gi;

/**
 * Strip voice effect tags from a string.
 * Removes inline tags like [pause] and wrapping tags like <soft>...</soft>
 * that are only valid inside send_voice_message TTS text.
 * @param {string} text
 * @returns {string}
 */
function stripVoiceTags(text) {
  if (!text) return text;
  return text.replace(VOICE_TAGS_INLINE_RE, '').replace(VOICE_TAGS_WRAP_RE, '');
}

/**
 * Normalize Markdown for WhatsApp (which has limited MD support).
 * - ### → removed (headings not supported)
 * - * bullet points → - bullet points (better compatibility)
 * - **text** → *text* (bold)
 * - __text__ → _text_ (italic)
 * - ~~text~~ → ~text~ (strikethrough)
 * @param {string} text
 * @returns {string}
 */
function normalizeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  // Remove heading markers (###) completely - WhatsApp doesn't support them
  text = text.replace(/^#{1,6}\s+/gm, '');
  // * bullet points → - bullet points (better WhatsApp compatibility)
  text = text.replace(/^\*\s+/gm, '- ');
  // **text** → *text* (bold)
  text = text.replace(/\*\*([^\*]+)\*\*/g, '*$1*');
  // __text__ → _text_ (italic)
  text = text.replace(/__([^_]+)__/g, '_$1_');
  // ~~text~~ → ~text~ (strikethrough)
  text = text.replace(/~~([^~]+)~~/g, '~$1~');
  return text;
}

/**
 * Strip [image:N] tags from a string.
 * @param {string} text
 * @returns {string}
 */
function stripImageTags(text) {
  if (!text) return text;
  return text.replace(/\[image:\d+\]/gi, '');
}

module.exports = { sanitizeFilename, stripVoiceTags, normalizeMarkdown, stripImageTags };
