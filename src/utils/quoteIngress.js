// Quote/reply handling when the referenced message is inside or outside MAX_HISTORY.

const { PLATFORM_WA_DEDICATED } = require('../config/constants');
const {
  REPLY_OUTSIDE_HISTORY_PREFIX,
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

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

function isInRecentHistory(recentIds, key) {
  return Boolean(key) && recentIds instanceof Set && recentIds.has(key);
}

/**
 * WhatsApp quoted message → prefix string + optional native media parts.
 */
async function processWhatsAppQuotedReply(msg, chatId, historyStorageId, recentMessageIds, isGroup = false, platform = PLATFORM_WA_DEDICATED) {
  if (!msg.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return { prefix: '', mediaParts: [] };

    const quotedKey = waMessageKey(quoted);
    if (!isInRecentHistory(recentMessageIds, quotedKey)) {
      return { prefix: REPLY_OUTSIDE_HISTORY_PREFIX, mediaParts: [] };
    }

    // Location / scheduled event: quote the parsed data, never the raw payload.
    const quotedSpecial = formatSpecialMessageText(quoted);
    if (quotedSpecial !== null) {
      return { prefix: `[In reply to: ${quotedSpecial}]\n`, mediaParts: [] };
    }
    // Shared contact: parse the vCard rather than quoting the raw payload.
    if (quoted.type === 'vcard' || quoted.type === 'multi_vcard') {
      return { prefix: `[In reply to: ${formatWhatsAppContactText(quoted.body || '')}]\n`, mediaParts: [] };
    }
    // Poll: quote question + options. Resolve mentions/LID tags in the
    // question first so a tagged user never appears as a raw @lid id.
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

    if (quoted.hasMedia) {
      const mediaResult = await _processWhatsAppQuotedMedia(quoted, historyStorageId);
      if (quoted.body) {
        const mentionContacts = await resolveMentionsForMessage(quoted, isGroup);
        let rawQuoted = replaceMentionsInBody(quoted.body, mentionContacts);
        if (isGroup) rawQuoted = await resolveLidTagsInBody(rawQuoted, new Set());
        const quotedText = cleanIncomingText(rawQuoted);
        return {
          prefix: `${mediaResult.prefix}[In reply to text: ${quotedText}]\n`,
          mediaParts: mediaResult.mediaParts,
        };
      }
      return mediaResult;
    }

    if (quoted.body) {
      const mentionContacts = await resolveMentionsForMessage(quoted, isGroup);
      let rawQuoted = replaceMentionsInBody(quoted.body, mentionContacts);
      if (isGroup) rawQuoted = await resolveLidTagsInBody(rawQuoted, new Set());
      const quotedText = cleanIncomingText(rawQuoted);
      return { prefix: `[In reply to: ${quotedText}]\n`, mediaParts: [] };
    }

    return { prefix: '[In reply to a message]\n', mediaParts: [] };
  } catch (err) {
    log.warn(`WA quoted message handling failed: ${err.message}`);
    return { prefix: '', mediaParts: [] };
  }
}

async function _processWhatsAppQuotedMedia(quoted, historyStorageId) {
  const ingress = await ingressWaMessageMedia(quoted, historyStorageId, {});
  const inner = ingress.textFragment.trim();
  return {
    prefix: `[In reply to: ${inner}]\n`,
    mediaParts: ingress.contentParts,
  };
}

/**
 * Discord quoted message → prefix + optional media parts for current turn.
 */
async function processDiscordQuotedReply(msg, channel, historyStorageId, recentMessageIds) {
  if (!msg.reference) return { prefix: '', mediaParts: [] };

  try {
    const quotedMsg = await channel.messages.fetch(msg.reference.messageId);
    if (!quotedMsg) return { prefix: '', mediaParts: [] };

    if (!isInRecentHistory(recentMessageIds, quotedMsg.id)) {
      return { prefix: REPLY_OUTSIDE_HISTORY_PREFIX, mediaParts: [] };
    }

    const mediaParts = [];
    let prefix = '';

    if (quotedMsg.attachments.size > 0) {
      for (const att of quotedMsg.attachments.values()) {
        const ingress = await ingressDiscordAttachment(att, historyStorageId, {
          metadataDurationSec: Number(att.duration || 0),
        });
        mediaParts.push(...ingress.contentParts);
        prefix += `[In reply to: ${ingress.textFragment.trim()}]\n`;
      }
      if (quotedMsg.content) {
        const textPart = `[In reply to: ${cleanIncomingText(quotedMsg.content)}]\n`;
        prefix += textPart;
      }
      return { prefix, mediaParts };
    }

    if (quotedMsg.content) {
      return {
        prefix: `[In reply to: ${cleanIncomingText(quotedMsg.content)}]\n`,
        mediaParts: [],
      };
    }

    return { prefix: '', mediaParts: [] };
  } catch (err) {
    log.warn(`Discord quoted message handling failed: ${err.message}`);
    return { prefix: '', mediaParts: [] };
  }
}

module.exports = {
  processWhatsAppQuotedReply,
  processDiscordQuotedReply,
};
