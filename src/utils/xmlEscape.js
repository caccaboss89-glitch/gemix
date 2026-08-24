// src/utils/xmlEscape.js
//
// Shared XML escape utility used when building structured prompts
// (especially in the history projection and other XML-tagged contexts).
// Provides basic escaping for &, <, >, and " characters.

/**
 * Escape XML special characters and always return an interpolation-safe string.
 * @param {*} value
 * @returns {string} Escaped string safe for XML attribute/content use
 */
function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { escapeXml };
