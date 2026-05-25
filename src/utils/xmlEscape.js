// src/utils/xmlEscape.js
// Shared XML escape utility for system-prompt builders.

/**
 * Escape XML special characters in a string.
 * @param {string} str - Input string
 * @returns {string} Escaped string safe for XML attribute/content use
 */
function escapeXml(str) {
  if (!str) return str;
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { escapeXml };
