// src/utils/discord.js
//
// Utility for cleaning Discord-specific formatting from text before it
// reaches the AI or is used in other contexts. Removes custom emojis,
// user/role/channel mentions, etc.

 /**
 * Remove Discord custom emojis, mentions, and other Discord-specific markdown from text.
 * Removes patterns like <:name:id>, <@!id>, <#id>, <@&id>, etc.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text without Discord-specific formatting
 */
function removeDiscordEmoji(text) {
  if (!text) return text;
  // Remove Discord custom emoji format: <:name:id>
  text = text.replace(/<:[a-zA-Z0-9_]+:\d+>/g, '');
  // Remove Discord user mention format: <@!id> or <@id>
  text = text.replace(/<@!?\d+>/g, '');
  // Remove Discord channel mention format: <#id>
  text = text.replace(/<#\d+>/g, '');
  // Remove Discord role mention format: <@&id>
  text = text.replace(/<@&\d+>/g, '');
  // Collapse runs of horizontal whitespace (spaces/tabs) left behind, but keep
  // newlines intact so multi-line bodies and trailing footers stay on their own lines.
  text = text.replace(/[^\S\r\n]{2,}/g, ' ').replace(/[^\S\r\n]+\n/g, '\n').trim();
  return text;
}

/**
 * Sanitize a Discord forum thread title before setName.
 * Strips Discord emoji/mention syntax and control characters; caps length.
 * @param {string} title
 * @param {number} [maxLen=100]
 * @returns {string}
 */
function sanitizeDiscordThreadTitle(title, maxLen = 100) {
  if (!title || typeof title !== 'string') return '';
  const cleaned = removeDiscordEmoji(title.replace(/[\u0000-\u001F]/g, ''));
  return cleaned.trim().substring(0, maxLen);
}

module.exports = { removeDiscordEmoji, sanitizeDiscordThreadTitle };
