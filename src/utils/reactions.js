// src/utils/reactions.js
//
// Read-only rendering of emoji reactions attached to a chat message, so GemiX
// can SEE reactions on both user and its own (bot) messages — in the current
// turn and rebuilt history. GemiX never adds reactions; reacting to a GemiX
// message never triggers a turn (no reaction event is listened to on either
// platform — these helpers only read reactions off messages already fetched).
//
// Output is a single inline tag appended to the message text, e.g.
//   [Reactions: ❤️ x2, 👍]
// Empty string when the message has no reactions (nothing changes, as before).

const { createLogger } = require('./logger');

const log = createLogger('Reactions');

/**
 * Turn a Map<emoji, count> into the display list, dropping empties.
 * @param {Map<string, number>} counts
 * @returns {string} tag or '' when there are no reactions
 */
function _formatCounts(counts) {
  if (!(counts instanceof Map) || counts.size === 0) return '';
  const parts = [];
  for (const [emoji, count] of counts) {
    if (!emoji) continue;
    const n = Number(count) || 0;
    parts.push(n > 1 ? `${emoji} x${n}` : emoji);
  }
  if (parts.length === 0) return '';
  return `[Reactions: ${parts.join(', ')}]`;
}

/**
 * Accumulate one WhatsApp message's reactions into a shared counts map.
 *
 * whatsapp-web.js exposes `msg.hasReaction` (cheap boolean) and
 * `await msg.getReactions()`. The return shape differs across forks: either a
 * grouped list ({ aggregateEmoji, senders: [...] }) or a flat list of
 * per-sender reactions ({ reaction }). Both are handled defensively; any
 * missing API or error is swallowed (feature simply stays off).
 *
 * @param {Map<string, number>} counts
 * @param {object} msg - whatsapp-web.js Message
 */
async function _collectWhatsAppReactions(counts, msg) {
  try {
    if (!msg || !msg.hasReaction || typeof msg.getReactions !== 'function') return;
    const raw = await msg.getReactions();
    if (!Array.isArray(raw) || raw.length === 0) return;
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      // Grouped shape: one entry per emoji with a senders array.
      if (typeof entry.aggregateEmoji === 'string' && entry.aggregateEmoji) {
        const senders = Array.isArray(entry.senders) ? entry.senders.length : 0;
        const n = senders > 0 ? senders : (Number(entry.count) || 1);
        counts.set(entry.aggregateEmoji, (counts.get(entry.aggregateEmoji) || 0) + n);
        continue;
      }
      // Flat shape: one entry per sender.
      if (typeof entry.reaction === 'string' && entry.reaction) {
        counts.set(entry.reaction, (counts.get(entry.reaction) || 0) + 1);
      }
    }
  } catch (err) {
    log.debug(`WhatsApp reaction read failed: ${err.message}`);
  }
}

/**
 * Reaction tag for one WhatsApp message.
 * @param {object} msg - whatsapp-web.js Message
 * @returns {Promise<string>}
 */
async function whatsAppReactionTag(msg) {
  const counts = new Map();
  await _collectWhatsAppReactions(counts, msg);
  return _formatCounts(counts);
}

/**
 * Merged reaction tag across several WhatsApp messages (one logical turn, e.g.
 * a multi-attach album where a reaction may sit on any item).
 * @param {object[]} msgs
 * @returns {Promise<string>}
 */
async function whatsAppReactionTagForMessages(msgs) {
  const list = Array.isArray(msgs) ? msgs.filter(Boolean) : [];
  if (list.length === 0) return '';
  const counts = new Map();
  for (const m of list) {
    await _collectWhatsAppReactions(counts, m);
  }
  return _formatCounts(counts);
}

/**
 * Reaction tag for a Discord message. `msg.reactions.cache` is populated from
 * the fetched message payload (no gateway reaction intent required). Custom
 * server emoji render as :name:; unicode emoji render as the character.
 *
 * @param {object} msg - discord.js Message
 * @returns {string}
 */
function discordReactionTag(msg) {
  try {
    const cache = msg && msg.reactions && msg.reactions.cache;
    if (!cache || cache.size === 0) return '';
    const counts = new Map();
    for (const reaction of cache.values()) {
      const emoji = reaction && reaction.emoji;
      if (!emoji) continue;
      const label = emoji.id ? `:${emoji.name}:` : (emoji.name || '');
      if (!label) continue;
      const n = Number(reaction.count) || 1;
      counts.set(label, (counts.get(label) || 0) + n);
    }
    return _formatCounts(counts);
  } catch (err) {
    log.debug(`Discord reaction read failed: ${err.message}`);
    return '';
  }
}

/**
 * Merge a reaction tag into existing message text (space-separated, trimmed).
 * @param {string} text
 * @param {string} tag
 * @returns {string}
 */
function appendReactionTag(text, tag) {
  if (!tag) return text;
  return `${text || ''} ${tag}`.trim();
}

module.exports = {
  whatsAppReactionTag,
  whatsAppReactionTagForMessages,
  discordReactionTag,
  appendReactionTag,
};
