import constants from '../../config/constants.js';
import { formatSpecialMessageText } from '../../utils/waSpecialMessages.js';
import { participantPhoneDigits, pickCaptionMessage, specialMessageText } from './messageText.js';
import { formatTimestamp } from '../../utils/time.js';
import { hasScheduledFooter } from '../../utils/footer.js';
import { buildPersonalGemixFlags } from '../../utils/personalWaHistory.js';
import { isSystemMessage } from '../../config/systemMessages.js';
import { wrapSystemNotification } from '../../utils/systemTags.js';
import { buildAttachmentTag } from '../../attachments/ingress.js';
import { resolveChatWorkspaceId } from '../../utils/workspaceId.js';
import { assistantTextItem, userItem } from '../../ai/responsesItems.js';
import { bindGemixVoiceTranscription } from '../../utils/historySync.js';
import { ingressWaMessageMedia } from '../../utils/incomingMediaIngress.js';
import { cleanIncomingText } from '../../utils/text.js';
import {
  attachmentFilenameHints,
  stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag
} from '../../utils/attachmentCaption.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { createLogger } from '../../utils/logger.js';
import { resolveIngressFilename } from '../../utils/attachmentFilenames.js';
import { replaceMentionsInBody, resolveMentionsForMessage, resolveLidTagsInBody } from '../../utils/waMentions.js';
import { processWhatsAppQuotedReply } from '../../utils/quoteIngress.js';
import { groupWhatsAppMessages } from '../../utils/waAlbumGroup.js';
import { whatsAppReactionTagForMessages } from '../../utils/reactions.js';
import { fetchWhatsAppMessageWindow, waMessageKey } from './messageWindow.js';

const { PLATFORM_WA_PERSONAL } = constants;
const HISTORY_INGRESS_CONCURRENCY = 15;
const log = createLogger('WhatsAppHistory');

function _historyMeta({ senderName = null, isGemiX = false, isScheduled = false, isSystem = false }) {
  return {
    senderName,
    isGemiX,
    isScheduled,
    isSystem,
    isFromBot: isGemiX || isScheduled || isSystem,
    isSystemEvent: isScheduled || isSystem
  };
}

function _createSenderResolver(platform, personalGemixFlags) {
  return async (msg, messageIndex) => {
    if (!msg.fromMe) {
      try {
        const contact = await msg.getContact();
        return _historyMeta({ senderName: contact.pushname || contact.name || msg.from });
      } catch {
        return _historyMeta({ senderName: msg.from || 'Unknown' });
      }
    }
    if (hasScheduledFooter(msg.body)) return _historyMeta({ isScheduled: true });
    if (isSystemMessage(msg.body)) return _historyMeta({ isSystem: true });
    if (platform === PLATFORM_WA_PERSONAL && !personalGemixFlags[messageIndex]) {
      return _historyMeta({ senderName: 'Account Owner' });
    }
    return _historyMeta({ senderName: 'GemiX', isGemiX: true });
  };
}

async function _ingestHistoryMedia({
  groupMessages,
  captionMsg,
  text,
  userId,
  workspaceId,
  signal,
  platform,
  isGemiX,
  chat
}) {
  for (let index = 0; index < groupMessages.length; index++) {
    const msg = groupMessages[index];
    if (!msg.hasMedia || formatSpecialMessageText(msg) !== null) continue;
    const waFilename = msg._data?.filename;
    const resolvedName = resolveIngressFilename(waFilename, msg._data?.mimetype, msg.id?.id);
    const filenameHints = attachmentFilenameHints(waFilename, resolvedName, null);
    if (index === 0 || msg === captionMsg) text = stripRedundantAttachmentCaption(text, filenameHints);

    const ingress = await ingressWaMessageMedia(msg, userId, { workspaceId, inline: false, signal });
    signal?.throwIfAborted();
    if (platform !== PLATFORM_WA_PERSONAL && isGemiX
        && (msg.type === 'audio' || msg.type === 'ptt') && ingress.syncedPath) {
      await bindGemixVoiceTranscription(
        userId,
        ingress.syncedPath,
        chat.id._serialized,
        (msg.timestamp || 0) * 1000
      );
    }
    text = stripRedundantFilenameBesideAttachmentTag(text, ingress.tag, filenameHints);
    text = `${text} ${ingress.textFragment.trim()}`.trim();
    if (!text) text = (ingress.tag || buildAttachmentTag(resolvedName || waFilename || 'file')).trim();
  }
  return text;
}

async function _prependHistoryQuote({
  groupMessages,
  text,
  chat,
  userId,
  recentMessageIds,
  isGroup,
  platform,
  workspaceId,
  lidCtx,
  signal
}) {
  const quoteMsg = groupMessages.find(message => message.hasQuotedMsg) || null;
  if (!quoteMsg) return text;
  try {
    const quoted = await processWhatsAppQuotedReply(
      quoteMsg,
      chat.id._serialized,
      userId,
      recentMessageIds,
      isGroup,
      platform,
      { includeQuotedMedia: false, workspaceId, lidCtx }
    );
    return quoted.prefix ? `${quoted.prefix}${text || ''}`.trimEnd() : text;
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    log.warn(`History quote expand failed: ${err.message}`);
    return text;
  }
}

/** Build the model-visible WhatsApp history for one prefetched chat window. */
async function buildWhatsAppHistory(chat, platform, userId, excludeKeys = null, prefetched = null, options = {}) {
  const { signal = null } = options;
  signal?.throwIfAborted();
  const workspaceId = resolveChatWorkspaceId(platform, chat, userId);
  const window = prefetched || await fetchWhatsAppMessageWindow(chat);
  signal?.throwIfAborted();
  const recentMessageIds = window.recentMessageIds;
  let messages = window.windowMessages;
  if (excludeKeys) {
    const excluded = excludeKeys instanceof Set ? excludeKeys : new Set([excludeKeys]);
    messages = messages.filter(message => {
      const key = waMessageKey(message);
      return !key || !excluded.has(key);
    });
  }

  const isGroup = Boolean(chat?.isGroup);
  const lidCtx = {
    phones: isGroup ? participantPhoneDigits(chat) : new Set(),
    cache: new Map()
  };
  const personalGemixFlags = platform === PLATFORM_WA_PERSONAL
    ? buildPersonalGemixFlags(messages)
    : null;
  const isHistoryBotMessage = (message, index) => platform === PLATFORM_WA_PERSONAL
    ? Boolean(message.fromMe && personalGemixFlags && personalGemixFlags[index])
    : Boolean(message.fromMe);
  const groups = groupWhatsAppMessages(messages, { isBotAt: isHistoryBotMessage });
  const resolveSender = _createSenderResolver(platform, personalGemixFlags);

  const processGroup = async group => {
    signal?.throwIfAborted();
    const groupMessages = group.messages;
    const primaryMsg = groupMessages[0];
    const meta = await resolveSender(primaryMsg, group.start);
    const captionMsg = pickCaptionMessage(groupMessages);
    const timestamp = formatTimestamp(primaryMsg.timestamp * 1000);
    const contacts = await resolveMentionsForMessage(captionMsg, isGroup);
    let text = replaceMentionsInBody(captionMsg.body || '', contacts);
    if (isGroup) text = await resolveLidTagsInBody(text, lidCtx.phones, lidCtx.cache);
    text = cleanIncomingText(text);
    const specialText = specialMessageText(captionMsg, text);
    if (specialText !== null) text = specialText;

    text = await _ingestHistoryMedia({
      groupMessages,
      captionMsg,
      text,
      userId,
      workspaceId,
      signal,
      platform,
      isGemiX: meta.isGemiX,
      chat
    });
    text = await _prependHistoryQuote({
      groupMessages,
      text,
      chat,
      userId,
      recentMessageIds,
      isGroup,
      platform,
      workspaceId,
      lidCtx,
      signal
    });
    if (!text) return null;

    const reactionTag = await whatsAppReactionTagForMessages(groupMessages);
    if (reactionTag) text = `${text} ${reactionTag}`.trim();
    const finalText = meta.isSystemEvent
      ? wrapSystemNotification(`[${timestamp}] ${text}`)
      : (meta.isFromBot ? text : `[${timestamp}] ${meta.senderName}: ${text}`);
    return meta.isFromBot && !meta.isSystemEvent
      ? assistantTextItem(finalText)
      : userItem(finalText);
  };

  const built = await mapWithConcurrency(groups, HISTORY_INGRESS_CONCURRENCY, processGroup);
  signal?.throwIfAborted();
  return built.filter(Boolean);
}

export { buildWhatsAppHistory };
