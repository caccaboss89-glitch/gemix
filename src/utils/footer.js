// src/utils/footer.js
//
// Utilities for adding/removing the standard GemiX footer and for
// formatting model names. Also handles scheduled message footers.

import constants from '../config/constants.js';
import { profileFromContext } from '../ai/providers/providerProfile.js';

/**
 * Append a suffix that starts with a blank line (e.g. constants.GEMIX_FOOTER_PREFIX).
 * Strips trailing whitespace on the body so the suffix never lands on the same line.
 */
function appendBlock(body, suffix) {
  const trimmed = typeof body === 'string' ? body.replace(/\s+$/u, '') : '';
  return trimmed + suffix;
}

/**
 * Map model ID to human-readable display name.
 * @param {string} modelId - The model identifier (e.g., 'grok-4-latest')
 * @param {object} [ctx] - anything carrying the turn's providerProfile
 * @returns {string} The human-readable model name or the original ID if not found
 */
function getModelDisplayName(modelId, ctx) {
  if (!modelId) return 'AI Model';
  // The brand comes from the profile, never from the slug: "gpt-5.6-sol" would
  // otherwise render as "Gpt 5.6 Sol" instead of the name the profile states.
  const profile = profileFromContext(ctx);
  if (modelId === profile.model) return profile.displayName;
  const slug = modelId.split('/').pop().split(':')[0];
  const grokVersion = slug.match(/^grok-(\d+(?:\.\d+)?)(?:-|$)/);
  if (grokVersion) return `Grok ${grokVersion[1]}`;
  const name = slug.replace(/[-_]/g, ' ');
  return name.replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Append GemiX footer with model name to text.
 * @param {string} text - The original text
 * @param {string} modelName - The model display name
 * @returns {string} Text with appended GemiX footer
 */
function addFooter(text, modelName) {
  const body = removeScheduledFooter(removeFooter(text || ''));
  return appendBlock(body, `${constants.GEMIX_FOOTER_PREFIX}${modelName}`);
}

/**
 * Remove GemiX footer from text.
 * @param {string} text - The text potentially containing a footer
 * @returns {string} Text with footer removed and trimmed
 */
function removeFooter(text) {
  if (!text) return '';
  return text.replace(/\n*--GemiX\s*•(?!\s*Messaggio Programmato)[^\n]*/gi, '').trim();
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
  return text.replace(/\n*--GemiX\s*•\s*Messaggio Programmato il[^\n]*/gi, '').trim();
}

/**
 * Build the footer for scheduled messages with formatted timestamp.
 * @param {string} createdAt - ISO date string of when the task was created
 * @returns {string} Formatted footer string with scheduled message timestamp
 */
function buildScheduledFooter(createdAt) {
  const d = new Date(createdAt);
  const formatted = d.toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${constants.GEMIX_FOOTER_PREFIX}Messaggio Programmato il ${formatted}`;
}

/**
 * Append scheduled footer to message body (strips any prior footers first).
 * @param {string} text
 * @param {string} createdAt
 * @returns {string}
 */
function addScheduledFooter(text, createdAt) {
  const body = removeScheduledFooter(removeFooter(text || ''));
  return appendBlock(body, buildScheduledFooter(createdAt));
}

/**
 * Build the server-side research badge line (web/X counts).
 * @param {{ webSources?: number, xPosts?: number }|null} stats
 * @returns {string|null} e.g. "🌐: 3 sources. 𝕏: 1 post." or null when no badge applies
 */
function buildResearchBadgeText(stats) {
  if (!stats) return null;
  const webSources = stats.webSources || 0;
  const xPosts = stats.xPosts || 0;
  if (webSources <= 0 && xPosts <= 0) return null;
  const parts = [];
  if (webSources > 0) parts.push(`🌐: ${webSources} source${webSources === 1 ? '' : 's'}`);
  if (xPosts > 0) parts.push(`𝕏: ${xPosts} post${xPosts === 1 ? '' : 's'}`);
  return `${parts.join('. ')}.`;
}

/**
 * Append the research badge block to a text reply (text replies only).
 * @param {string} text
 * @param {{ webSources?: number, xPosts?: number }|null} stats
 * @returns {string}
 */
function appendResearchBadge(text, stats) {
  const badge = buildResearchBadgeText(stats);
  if (!badge || !text || !String(text).trim()) return text;
  return appendBlock(text, `\n\n${badge}`);
}

export {
  addFooter,
  removeFooter,
  hasFooter,
  addScheduledFooter,
  getModelDisplayName,
  hasScheduledFooter,
  removeScheduledFooter,
  buildResearchBadgeText,
  appendResearchBadge

};
