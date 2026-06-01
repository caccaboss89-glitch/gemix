// src/utils/footer.js
//
// Utilities for adding/removing the standard GemiX footer and for
// formatting model names. Also handles scheduled message footers.

const { GEMIX_FOOTER_PREFIX } = require('../config/constants');

/**
 * Map model ID to human-readable display name.
 * @param {string} modelId - The model identifier (e.g., 'grok-4-latest')
 * @returns {string} The human-readable model name or the original ID if not found
 */
function getModelDisplayName(modelId) {
  if (!modelId) return 'AI Model';
  const map = {
    'grok-4.3-latest': 'Grok 4.3',
    'grok-4.3': 'Grok 4.3',
  };
  if (map[modelId]) return map[modelId];
  const parts = modelId.split('/');
  const name = parts[parts.length - 1].split(':')[0].replace(/[-_]/g, ' ');
  return name.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Append GemiX footer with model name to text.
 * @param {string} text - The original text
 * @param {string} modelName - The model display name
 * @returns {string} Text with appended GemiX footer
 */
function addFooter(text, modelName) {
  return text + GEMIX_FOOTER_PREFIX + modelName;
}

/**
 * Remove GemiX footer from text.
 * @param {string} text - The text potentially containing a footer
 * @returns {string} Text with footer removed and trimmed
 */
function removeFooter(text) {
  if (!text) return '';
  return text.replace(/\n+--GemiX\s*•.*$/gi, '').trim();
}

/**
 * Check if text contains a GemiX footer.
 * @param {string} text - The text to check
 * @returns {boolean} True if text contains a GemiX footer
 */
function hasFooter(text) {
  if (!text) return false;
  return /--GemiX\s*•/i.test(text);
}

/**
 * Check if text contains a scheduled message footer.
 * @param {string} text - The text to check
 * @returns {boolean} True if text contains a scheduled message footer
 */
function hasScheduledFooter(text) {
  if (!text) return false;
  return /Messaggio Programmato il/i.test(text);
}

/**
 * Remove scheduled message footer from text.
 * @param {string} text - The text potentially containing a scheduled footer
 * @returns {string} Text with scheduled footer removed and trimmed
 */
function removeScheduledFooter(text) {
  if (!text) return '';
  return text.replace(/\n+--GemiX\s*•\s*Messaggio Programmato il.*$/gi, '').trim();
}

/**
 * Build the footer for scheduled messages with formatted timestamp.
 * @param {string} createdAt - ISO date string of when the task was created
 * @returns {string} Formatted footer string with scheduled message timestamp
 */
function buildScheduledFooter(createdAt) {
  const d = new Date(createdAt);
  const formatted = d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${GEMIX_FOOTER_PREFIX}Messaggio Programmato il ${formatted}`;
}

module.exports = { addFooter, removeFooter, hasFooter, buildScheduledFooter, getModelDisplayName, hasScheduledFooter, removeScheduledFooter };
