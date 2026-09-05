import constants from '../../config/constants.js';
import { participantPhoneDigits, pickCaptionMessage, specialMessageText } from './messageText.js';
import { resolveChatWorkspaceId } from '../../utils/workspaceId.js';
import { ingressWaMessageMedia } from '../../utils/incomingMediaIngress.js';
import { formatLabeledUserContent } from '../../utils/text.js';
import {
  attachmentFilenameHints,
  stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag
} from '../../utils/attachmentCaption.js';
import {
  replaceMentionsInBody,
  resolveMentionsForMessage,
  resolveLidTagsInBody
} from '../../utils/waMentions.js';
import { processWhatsAppQuotedReply } from '../../utils/quoteIngress.js';
import { whatsAppReactionTagForMessages } from '../../utils/reactions.js';
import { getRecentWhatsAppMessageIds } from './messageWindow.js';

/** Ingest the current message media and project it as a tag plus optional image part. */
async function processCurrentMedia(msg, userId, options = {}) {
  if (!msg.hasMedia) return null;
  const result = await ingressWaMessageMedia(msg, userId, {
    workspaceId: options.workspaceId || null,
    inline: true,
    imagesInlined: options.imagesInlined || 0
  });
  if (result.unsupported) return { skipped: true, tag: result.tag, fragment: result.tag };
  if (result.overDurationLimit) {
    return {
      skipped: true,
      tag: result.tag,
      fragment: result.textFragment.trim(),
      overDurationLimit: result.overDurationLimit
    };
  }
  if (result.contentParts.length > 0) {
    return {
      skipped: false,
      mimetype: result.mimetype,
      filename: result.filename,
      syncedPath: result.syncedPath,
      tag: result.tag,
      contentParts: result.contentParts
    };
  }
  return {
    skipped: true,
    tag: result.tag,
    fragment: result.textFragment.trim(),
    filename: result.filename,
    syncedPath: result.syncedPath
  };
}

async function _resolveInitialText(messages, isGroup) {
  const captionMsg = pickCaptionMessage(messages);
  const mentionContacts = await resolveMentionsForMessage(captionMsg, isGroup);
  let text = replaceMentionsInBody(captionMsg.body || '', mentionContacts);
  const lidCtx = { phones: new Set(), cache: new Map() };
  if (isGroup) {
    try { lidCtx.phones = participantPhoneDigits(await captionMsg.getChat()); }
    catch { /* best effort */ }
    text = await resolveLidTagsInBody(text, lidCtx.phones, lidCtx.cache);
  }
  const specialText = specialMessageText(captionMsg, text);
  return { captionMsg, lidCtx, specialText, text: specialText ?? text };
}

async function _prependQuote({
  messages,
  primaryMsg,
  chatId,
  userId,
  recentMessageIds,
  isGroup,
  platform,
  includeQuotedMedia,
  workspaceId,
  lidCtx,
  contentParts,
  text
}) {
  const quoteMsg = messages.find(message => message.hasQuotedMsg) || null;
  const recentIds = recentMessageIds || await getRecentWhatsAppMessageIds(quoteMsg || primaryMsg);
  if (!quoteMsg) return { quoteMsg, text };
  const quoted = await processWhatsAppQuotedReply(
    quoteMsg,
    chatId,
    userId,
    recentIds,
    isGroup,
    platform,
    { includeQuotedMedia, workspaceId, lidCtx }
  );
  if (quoted?.prefix) text = quoted.prefix + text;
  if (quoted?.mediaParts?.length) contentParts.push(...quoted.mediaParts);
  return { quoteMsg, text };
}

async function _appendCurrentMedia({ messages, captionMsg, specialText, userId, workspaceId, contentParts, text }) {
  let imagesInlined = contentParts.filter(part => part?.type === 'input_image').length;
  for (const message of messages) {
    if (specialText !== null && message === captionMsg) continue;
    const media = specialText === null
      ? await processCurrentMedia(message, userId, { workspaceId, imagesInlined })
      : null;
    if (media?.contentParts?.length) {
      imagesInlined += media.contentParts.filter(part => part?.type === 'input_image').length;
    }

    const sourceName = message._data?.filename;
    if (media) {
      if (media.skipped) text = `${text} ${media.fragment || media.tag}`.trim();
      else {
        contentParts.push(...media.contentParts);
        text = `${text} ${media.tag}`.trim();
      }
      if (text) {
        const hints = attachmentFilenameHints(sourceName, media.filename, media.syncedPath);
        text = stripRedundantAttachmentCaption(text, hints);
        if (media.tag) text = stripRedundantFilenameBesideAttachmentTag(text, media.tag, hints);
      }
    } else if (sourceName) {
      text = stripRedundantAttachmentCaption(text, [sourceName]);
    }
  }
  return text;
}

/** Build one Responses content array for a WhatsApp message or media album. */
async function buildIncomingContentPartsFromMessages(
  msgOrMsgs,
  chatId,
  userId,
  isGroup = false,
  senderName = 'Unknown',
  platform = constants.PLATFORM_WA_DEDICATED,
  recentMessageIds = null,
  options = {}
) {
  const messages = (Array.isArray(msgOrMsgs) ? msgOrMsgs : [msgOrMsgs]).filter(Boolean);
  if (messages.length === 0) return [];

  const contentParts = [];
  const primaryMsg = messages[0];
  const initial = await _resolveInitialText(messages, isGroup);
  const workspaceId = resolveChatWorkspaceId(
    platform,
    { id: { _serialized: chatId }, isGroup },
    userId
  );
  const quoted = await _prependQuote({
    messages,
    primaryMsg,
    chatId,
    userId,
    recentMessageIds,
    isGroup,
    platform,
    includeQuotedMedia: options.includeQuotedMedia !== false,
    workspaceId,
    lidCtx: initial.lidCtx,
    contentParts,
    text: initial.text
  });
  let text = await _appendCurrentMedia({
    messages,
    captionMsg: initial.captionMsg,
    specialText: initial.specialText,
    userId,
    workspaceId,
    contentParts,
    text: quoted.text
  });

  if (!text.trim() && quoted.quoteMsg && contentParts.length === 0) text = '[In reply to a message]\n';
  const reactionTag = await whatsAppReactionTagForMessages(messages);
  if (reactionTag) text = `${text} ${reactionTag}`.trim();
  if (text.trim()) {
    contentParts.unshift({
      type: 'input_text',
      text: formatLabeledUserContent((primaryMsg.timestamp || 0) * 1000, senderName, text.trim())
    });
  }
  return contentParts;
}

export { buildIncomingContentPartsFromMessages, processCurrentMedia };
