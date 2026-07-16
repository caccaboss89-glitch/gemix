// Quote/reply handling when the referenced message is inside or outside MAX_HISTORY.
// Walks reply chains (A replies to B replies to C) and emits concatenated
// [In reply to: ...] prefixes so the model keeps cross-message context in both
// the current turn and rebuilt history.

const { PLATFORM_WA_DEDICATED } = require('../config/constants');
const {
  REPLY_OUTSIDE_HISTORY_PREFIX,
  REPLY_CHAIN_TRUNCATED_PREFIX,
  cleanIncomingText,
} = require('./text');
const { replaceMentionsInBody, resolveMentionsForMessage, resolveLidTagsInBody } = require('./waMentions');
const { formatSpecialMessageText, formatWhatsAppContactText } = require('./waSpecialMessages');
const { formatWhatsAppPollText } = require('./pollParser');
const {
  ingressWaMessageMedia,
  ingressDiscordAttachment,
} = require('./incomingMediaIngress');
const { createLogger } = require('./logger');

const log = createLogger('QuoteIngress');

/** Max hops to walk when expanding a reply chain (immediate quote = depth 0). */
const MAX_REPLY_CHAIN_DEPTH = 5;

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

function isInRecentHistory(recentIds, key) {
  return Boolean(key) && recentIds instanceof Set && recentIds.has(key);
}

function _outsideResult() {
  return { prefix: REPLY_OUTSIDE_HISTORY_PREFIX, mediaParts: [] };
}

/**
 * Resolve one WhatsApp message into a single reply-prefix line (+ optional media).
 * @param {object} quoted
 * @param {{ isGroup?: boolean, historyStorageId?: string, includeMedia?: boolean }} opts
 * @returns {Promise<{ prefix: string, mediaParts: Array }>}
 */
async function formatWhatsAppQuotedLevel(quoted, opts = {}) {
  const { isGroup = false, historyStorageId = null, includeMedia = true } = opts;

  const quotedSpecial = formatSpecialMessageText(quoted);
  if (quotedSpecial !== null) {
    return { prefix: `[In reply to: ${quotedSpecial}]\n`, mediaParts: [] };
  }
  if (quoted.type === 'vcard' || quoted.type === 'multi_vcard') {
    return {
      prefix: `[In reply to: ${formatWhatsAppContactText(quoted.body || '')}]\n`,
      mediaParts: [],
    };
  }
  if (quoted.type === 'poll_creation') {
    let questionBase = quoted.body || '';
    if (questionBase) {
      const mentionContacts = await resolveMentionsForMessage(quoted, isGroup);
      questionBase = replaceMentionsInBody(questionBase, mentionContacts);
      if (isGroup) questionBase = await resolveLidTagsInBody(questionBase, new Set());
    }
    const pollText = formatWhatsAppPollText(quoted, `[Poll] ${questionBase}`);
    return { prefix: `[In reply to: ${pollText}]\n`, mediaParts: [] };
  }

  let quotedText = '';
  if (quoted.body) {
    const mentionContacts = await resolveMentionsForMessage(quoted, isGroup);
    let rawQuoted = replaceMentionsInBody(quoted.body, mentionContacts);
    if (isGroup) rawQuoted = await resolveLidTagsInBody(rawQuoted, new Set());
    quotedText = cleanIncomingText(rawQuoted);
  }

  if (quoted.hasMedia) {
    const ingress = await ingressWaMessageMedia(quoted, historyStorageId, {
      tagOnly: !includeMedia,
    });
    const inner = ingress.textFragment.trim();
    const mediaParts = includeMedia ? (ingress.contentParts || []) : [];
    // Same shape as Discord: one or more "[In reply to: …]" lines (no "text" variant).
    if (quotedText) {
      return {
        prefix: `[In reply to: ${inner}]\n[In reply to: ${quotedText}]\n`,
        mediaParts,
      };
    }
    return {
      prefix: `[In reply to: ${inner}]\n`,
      mediaParts,
    };
  }

  if (quotedText) {
    return { prefix: `[In reply to: ${quotedText}]\n`, mediaParts: [] };
  }

  return { prefix: '[In reply to a message]\n', mediaParts: [] };
}

/**
 * WhatsApp quoted message → concatenated reply-chain prefix + optional native media.
 * Media parts are only taken from the immediate quote (depth 0) when includeQuotedMedia.
 *
 * @param {object} msg
 * @param {string} chatId
 * @param {string} historyStorageId
 * @param {Set<string>} recentMessageIds
 * @param {boolean} [isGroup=false]
 * @param {string} [platform]
 * @param {{ maxChainDepth?: number, includeQuotedMedia?: boolean }} [options]
 */
async function processWhatsAppQuotedReply(
  msg,
  chatId,
  historyStorageId,
  recentMessageIds,
  isGroup = false,
  platform = PLATFORM_WA_DEDICATED,
  options = {},
) {
  void chatId;
  void platform;
  if (!msg?.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  const maxChainDepth = options.maxChainDepth ?? MAX_REPLY_CHAIN_DEPTH;
  const includeQuotedMedia = options.includeQuotedMedia !== false;

  try {
    const levels = [];
    const mediaParts = [];
    const visited = new Set();
    const startKey = waMessageKey(msg);
    if (startKey) visited.add(startKey);

    let current = msg;
    for (let depth = 0; depth < maxChainDepth; depth++) {
      if (!current?.hasQuotedMsg) break;

      let quoted;
      try {
        quoted = await current.getQuotedMessage();
      } catch (err) {
        log.warn(`WA getQuotedMessage failed at depth ${depth}: ${err.message}`);
        levels.push(_outsideResult());
        break;
      }

      if (!quoted) {
        levels.push(_outsideResult());
        break;
      }

      const quotedKey = waMessageKey(quoted);
      if (quotedKey) {
        if (visited.has(quotedKey)) break;
        visited.add(quotedKey);
      }

      if (!isInRecentHistory(recentMessageIds, quotedKey)) {
        levels.push(_outsideResult());
        break;
      }

      const level = await formatWhatsAppQuotedLevel(quoted, {
        isGroup,
        historyStorageId,
        includeMedia: includeQuotedMedia && depth === 0,
      });
      levels.push(level);
      if (level.mediaParts?.length) mediaParts.push(...level.mediaParts);

      current = quoted;
    }

    // Root-first: oldest quoted context first, then the immediate reply target.
    let prefix = levels
      .slice()
      .reverse()
      .map((l) => l.prefix)
      .join('');
    // Depth cap hit while older hops still exist
    if (levels.length >= maxChainDepth && current?.hasQuotedMsg) {
      prefix = `${REPLY_CHAIN_TRUNCATED_PREFIX}${prefix}`;
    }

    return { prefix, mediaParts };
  } catch (err) {
    log.warn(`WA quoted message handling failed: ${err.message}`);
    return _outsideResult();
  }
}

/**
 * Resolve one Discord message into reply-prefix line(s) + optional media.
 */
async function formatDiscordQuotedLevel(quotedMsg, historyStorageId, includeMedia) {
  const mediaParts = [];
  let prefix = '';

  if (quotedMsg.attachments?.size > 0) {
    for (const att of quotedMsg.attachments.values()) {
      const ingress = await ingressDiscordAttachment(att, historyStorageId, {
        metadataDurationSec: Number(att.duration || 0),
        tagOnly: !includeMedia,
      });
      if (includeMedia) mediaParts.push(...ingress.contentParts);
      prefix += `[In reply to: ${ingress.textFragment.trim()}]\n`;
    }
    if (quotedMsg.content) {
      prefix += `[In reply to: ${cleanIncomingText(quotedMsg.content)}]\n`;
    }
    return { prefix, mediaParts };
  }

  if (quotedMsg.content) {
    return {
      prefix: `[In reply to: ${cleanIncomingText(quotedMsg.content)}]\n`,
      mediaParts: [],
    };
  }

  return { prefix: '[In reply to a message]\n', mediaParts: [] };
}

/**
 * Discord quoted message → concatenated reply-chain prefix + optional media parts.
 *
 * @param {object} msg
 * @param {object} channel
 * @param {string} historyStorageId
 * @param {Set<string>} recentMessageIds
 * @param {{
 *   maxChainDepth?: number,
 *   includeQuotedMedia?: boolean,
 *   messageById?: Map<string, object>|null,
 * }} [options]
 */
async function processDiscordQuotedReply(msg, channel, historyStorageId, recentMessageIds, options = {}) {
  const refId = msg?.reference?.messageId;
  if (!refId) return { prefix: '', mediaParts: [] };

  const maxChainDepth = options.maxChainDepth ?? MAX_REPLY_CHAIN_DEPTH;
  const includeQuotedMedia = options.includeQuotedMedia !== false;
  const messageById = options.messageById || null;

  async function resolveMessage(id) {
    if (!id) return null;
    if (messageById?.has(id)) return messageById.get(id);
    try {
      return await channel.messages.fetch(id);
    } catch {
      return null;
    }
  }

  try {
    const levels = [];
    const mediaParts = [];
    const visited = new Set();
    if (msg.id) visited.add(msg.id);

    let nextId = refId;
    for (let depth = 0; depth < maxChainDepth; depth++) {
      if (!nextId) break;
      if (visited.has(nextId)) break;
      visited.add(nextId);

      if (!isInRecentHistory(recentMessageIds, nextId)) {
        levels.push(_outsideResult());
        break;
      }

      const quotedMsg = await resolveMessage(nextId);
      if (!quotedMsg) {
        levels.push(_outsideResult());
        break;
      }

      const level = await formatDiscordQuotedLevel(
        quotedMsg,
        historyStorageId,
        includeQuotedMedia && depth === 0,
      );
      levels.push(level);
      if (level.mediaParts?.length) mediaParts.push(...level.mediaParts);

      nextId = quotedMsg.reference?.messageId || null;
    }

    let prefix = levels
      .slice()
      .reverse()
      .map((l) => l.prefix)
      .join('');
    if (levels.length >= maxChainDepth && nextId) {
      prefix = `${REPLY_CHAIN_TRUNCATED_PREFIX}${prefix}`;
    }

    return { prefix, mediaParts };
  } catch (err) {
    log.warn(`Discord quoted message handling failed: ${err.message}`);
    return _outsideResult();
  }
}

module.exports = {
  processWhatsAppQuotedReply,
  processDiscordQuotedReply,
  formatWhatsAppQuotedLevel,
  formatDiscordQuotedLevel,
  MAX_REPLY_CHAIN_DEPTH,
};
