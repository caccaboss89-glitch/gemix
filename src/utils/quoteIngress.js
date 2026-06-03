// Quote/reply handling when the referenced message is inside or outside MAX_HISTORY.

const { PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED, MAX_HISTORY } = require('../config/constants');
const { hasScheduledFooter } = require('./footer');
const {
  buildPersonalGemixFlags,
  isPersonalQuotedGemix,
  isPersonalGemixMediaContinuation,
} = require('./personalWaHistory');
const { isSystemMessage } = require('../config/systemMessages');
const {
  REPLY_OUTSIDE_HISTORY_PREFIX,
  cleanIncomingText,
} = require('./text');
const { replaceMentionsInBody, resolveMentionsForMessage } = require('./waMentions');
const { resolveGemixVoiceTranscription } = require('./historySync');
const {
  ingressWaMessageMedia,
  ingressDiscordAttachment,
} = require('./incomingMediaIngress');
const { createLogger } = require('./logger');

const log = createLogger('QuoteIngress');

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

function isGemixWhatsAppMessage(msg, platform, isGroup = false) {
  if (!msg?.fromMe) return false;
  if (platform === PLATFORM_WA_PERSONAL) return isPersonalQuotedGemix(msg);
  if (hasScheduledFooter(msg.body) || isSystemMessage(msg.body)) return false;
  return true;
}

function isInRecentHistory(recentIds, key) {
  return Boolean(key) && recentIds instanceof Set && recentIds.has(key);
}

/** Personal: align quote GemiX detection with history flags (footerless voice/files). */
async function resolvePersonalQuotedIsGemix(quoted, ingressMsg) {
  if (isPersonalQuotedGemix(quoted)) return true;
  if (!quoted?.fromMe || !isPersonalGemixMediaContinuation(quoted)) return false;
  try {
    const chat = await ingressMsg.getChat();
    const raw = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
    const flags = buildPersonalGemixFlags(raw);
    const qKey = waMessageKey(quoted);
    for (let i = 0; i < raw.length; i++) {
      if (waMessageKey(raw[i]) === qKey) return flags[i];
    }
  } catch { /* ignore */ }
  return false;
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

    if (quoted.hasMedia) {
      const isQuotedGemix = platform === PLATFORM_WA_PERSONAL
        ? await resolvePersonalQuotedIsGemix(quoted, msg)
        : isGemixWhatsAppMessage(quoted, platform, isGroup);
      const mediaResult = await _processWhatsAppQuotedMedia(
        quoted, chatId, historyStorageId, isQuotedGemix, platform,
      );
      if (quoted.body) {
        const mentionContacts = await resolveMentionsForMessage(quoted, isGroup);
        const rawQuoted = replaceMentionsInBody(quoted.body, mentionContacts);
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
      const rawQuoted = replaceMentionsInBody(quoted.body, mentionContacts);
      const quotedText = cleanIncomingText(rawQuoted);
      return { prefix: `[In reply to: ${quotedText}]\n`, mediaParts: [] };
    }

    return { prefix: '[In reply to a message]\n', mediaParts: [] };
  } catch (err) {
    log.warn(`WA quoted message handling failed: ${err.message}`);
    return { prefix: '', mediaParts: [] };
  }
}

async function _processWhatsAppQuotedMedia(quoted, chatId, historyStorageId, isQuotedGemix, platform) {
  const isGemixVoice = isQuotedGemix && platform !== PLATFORM_WA_PERSONAL;
  const ingress = await ingressWaMessageMedia(quoted, historyStorageId, {
    chatId,
    isGemixVoice,
  });
  const inner = ingress.textFragment.trim();
  return {
    prefix: `[In reply to: ${inner}]\n`,
    mediaParts: ingress.contentParts,
  };
}

/**
 * Discord quoted message → prefix + optional media parts for current turn.
 */
async function processDiscordQuotedReply(msg, channel, historyStorageId, recentMessageIds, botUserId) {
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
        const isQuotedBot = quotedMsg.author.id === botUserId;
        const ingress = await ingressDiscordAttachment(att, historyStorageId, {
          metadataDurationSec: Number(att.duration || 0),
          getVoiceTranscription: isQuotedBot
            ? async (syncedPath) => resolveGemixVoiceTranscription(
              historyStorageId,
              syncedPath,
              channel.id,
              quotedMsg.createdAt?.getTime?.(),
            )
            : null,
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