const { GEMIX_FOOTER_PREFIX } = require('../config/constants');

/**
 * Map model ID to human-readable display name.
 */
function getModelDisplayName(modelId) {
  const map = {
    'google/gemini-3-flash-preview': 'Gemini 3 Flash',
    'x-ai/grok-4-1-fast-reasoning': 'Grok 4.1 Fast',
  };
  return map[modelId] || modelId;
}

function addFooter(text, modelName) {
  return text + GEMIX_FOOTER_PREFIX + modelName;
}

function removeFooter(text) {
  if (!text) return '';
  return text.replace(/\n+--GemiX •.*$/g, '').trim();
}

function hasFooter(text) {
  if (!text) return false;
  return text.includes('--GemiX •');
}

function stripGemixFooterFromResponse(text) {
  if (!text) return '';
  return text
    .replace(/\n+--GemiX\s*•.*$/gi, '')
    .trim();
}

/**
 * Build the footer for scheduled messages.
 * @param {string} createdAt - ISO date string of when the task was created
 */
function buildScheduledFooter(createdAt) {
  const d = new Date(createdAt);
  const formatted = d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${GEMIX_FOOTER_PREFIX}Messaggio Programmato il ${formatted}`;
}

module.exports = { addFooter, removeFooter, hasFooter, stripGemixFooterFromResponse, buildScheduledFooter, getModelDisplayName };
