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
  // Clean up extra spaces
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text;
}

module.exports = { removeDiscordEmoji };
