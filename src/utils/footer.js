const { GEMIX_FOOTER_PREFIX } = require('../config/constants');

/**
 * Map model ID to human-readable display name.
 * @param {string} modelId - The model identifier (e.g., 'gemini-3-flash-preview')
 * @returns {string} The human-readable model name or the original ID if not found
 */
function getModelDisplayName(modelId) {
  const map = {
    'google/gemini-2.5-flash-lite-preview': 'Gemini 2.5 Flash Lite',
    'x-ai/grok-4-1-fast-reasoning': 'Grok 4.1 Fast',
  };
  return map[modelId] || modelId;
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
  return text.includes('--GemiX •');
}

/**
 * Check if text contains a scheduled message footer.
 * @param {string} text - The text to check
 * @returns {boolean} True if text contains a scheduled message footer
 */
function hasScheduledFooter(text) {
  if (!text) return false;
  return text.includes('Messaggio Programmato il');
}

/**
 * Remove scheduled message footer from text.
 * @param {string} text - The text potentially containing a scheduled footer
 * @returns {string} Text with scheduled footer removed and trimmed
 */
function removeScheduledFooter(text) {
  if (!text) return '';
  return text.replace(/\n+--GemiX •\s*Messaggio Programmato il.*$/g, '').trim();
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
