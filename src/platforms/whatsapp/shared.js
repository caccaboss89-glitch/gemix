// src/platforms/whatsapp/shared.js
//
// Shared WhatsApp logic used by both dedicated.js and personal.js.
// Builds history, handles incoming media/quoted messages, processes
// current message attachments, and sends responses (text and/or voice on
// WA dedicated, plus file attachments). Central place for WhatsApp-specific
// formatting and media handling.

import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import constants from '../../config/constants.js';
import { formatWhatsAppPollText } from '../../utils/pollParser.js';
import { isSpecialNonMediaMessage, formatSpecialMessageText, formatWhatsAppContactText } from '../../utils/waSpecialMessages.js';
import { formatTimestamp } from '../../utils/time.js';
import { hasScheduledFooter } from '../../utils/footer.js';
import { buildPersonalGemixFlags } from '../../utils/personalWaHistory.js';
import { isSystemMessage } from '../../config/systemMessages.js';
import { wrapSystemNotification } from '../../utils/systemTags.js';
import { buildAttachmentTag } from '../../attachments/ingress.js';
import { resolveChatWorkspaceId } from '../../utils/workspaceId.js';
import { resolveGemixVoiceTranscription, storeRecentVoiceText } from '../../utils/historySync.js';
import { ingressWaMessageMedia } from '../../utils/incomingMediaIngress.js';
import {
  normalizeMarkdown,
  stripOutgoingDeliveryArtifacts,
  cleanIncomingText,
  formatLabeledUserContent
} from '../../utils/text.js';
import {
  attachmentFilenameHints as _attachmentFilenameHints,
  stripRedundantAttachmentCaption as _stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag as _stripRedundantFilenameBesideAttachmentTag
} from '../../utils/attachmentCaption.js';
import { sendAttachmentsWithFallback } from '../../utils/attachmentFallback.js';
import { sendWhatsAppAttachment, PLATFORM } from '../../utils/attachmentDelivery.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { withWaPuppeteerRetry, formatWaError } from '../../utils/waPuppeteer.js';
import { createLogger } from '../../utils/logger.js';
import {
  resolveIngressFilename as _resolveWaFilename
} from '../../utils/attachmentFilenames.js';
import {
  replaceMentionsInBody as _replaceMentionsInBody,
  resolveMentionsForMessage as _resolveMentionsForMessage,
  resolveLidTagsInBody as _resolveLidTagsInBody,
  stripDisallowedOutgoingMentions,
  normalizeOutgoingMentionTags,
  collectMentionJids
} from '../../utils/waMentions.js';
import { processWhatsAppQuotedReply } from '../../utils/quoteIngress.js';
import { groupWhatsAppMessages } from '../../utils/waAlbumGroup.js';
import { whatsAppReactionTagForMessages } from '../../utils/reactions.js';

const { MAX_HISTORY, PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED } = constants;

const log = createLogger('WhatsAppResponse');

// Max parallel attachment ingresses while building one history window. History
// carries tags only, so this bounds disk work, not anything sent to the model.
const HISTORY_INGRESS_CONCURRENCY = 15;

function _waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

async function getRecentWhatsAppMessageIds(msg) {
  try {
    const chat = await msg.getChat();
    const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
    return new Set(rawMessages.slice(-MAX_HISTORY).map(_waMessageKey).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Fetch last N messages from a WhatsApp chat and build history array.
 * Includes message context, media handling, and footer cleanup for GemiX messages.
 *
 * @param {object} chat - whatsapp-web.js Chat object
 * @param {string} platform - Platform identifier ('whatsapp_dedicated' | 'whatsapp_personal')
 * @param {string} userId - storage id for media sync
 * @param {Set<string>|string|null} [excludeKeys] - WhatsApp message keys (from _waMessageKey) to exclude from history.
 *   Current-batch messages are excluded from history (the user turn containing attachment tags/inline content is provided as the final turn instead).
 * @returns {Promise<Array>} Array of history messages with role ('user'|'assistant') and content
 */
async function buildWhatsAppHistory(chat, platform, userId, excludeKeys = null) {
  const workspaceId = resolveChatWorkspaceId(platform, chat, userId);
  const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
  const windowMessages = rawMessages.slice(-MAX_HISTORY);
  // Quote window = full MAX_HISTORY slice (incl. current-batch keys later excluded
  // from the history array). Matches getRecentWhatsAppMessageIds / current-turn logic.
  const recentMessageIds = new Set(windowMessages.map(_waMessageKey).filter(Boolean));
  let messages = windowMessages;

  // Exclude current message(s) being processed (they form the final user turn and are omitted from the history array)
  if (excludeKeys) {
    const toExclude = excludeKeys instanceof Set ? excludeKeys : new Set([excludeKeys]);
    messages = messages.filter(m => {
      const k = _waMessageKey(m);
      return !k || !toExclude.has(k);
    });
  }

  const isGroup = Boolean(chat?.isGroup);

  // Fast first level for LID tag resolution: phone numbers of the group's
  // current participants. Long @<digits> tags already matching one of these
  // are real phone tags; the rest are LIDs resolved via getContactLidAndPhone
  // (resolveLidTagsInBody), with a per-pass cache to avoid duplicate lookups.
  const knownGroupPhones = new Set();
  const lidTagCache = new Map();
  if (isGroup && Array.isArray(chat?.participants)) {
    for (const p of chat.participants) {
      if (p?.id?.server === 'c.us' && p.id.user) {
        const digits = p.id.user.toString().replace(/\D/g, '');
        if (digits) knownGroupPhones.add(digits);
      }
    }
  }

  const personalGemixFlags = platform === PLATFORM_WA_PERSONAL
    ? buildPersonalGemixFlags(messages)
    : null;

  // True when a history message came out of our own account (GemiX reply,
  // system notice, scheduled delivery) → always tag-only: GemiX's replies land
  // on the assistant role, which cannot carry native parts, and program notices
  // only ever reference files the user already received. On dedicated every
  // fromMe is bot; on personal only the GemiX-flagged fromMe is (Account Owner
  // is a user).
  const isHistoryBotMessage = (msg, mi) => (platform === PLATFORM_WA_PERSONAL
    ? Boolean(msg.fromMe && personalGemixFlags && personalGemixFlags[mi])
    : Boolean(msg.fromMe));


  // Album multi-attach (same sender, short time window, caption-less siblings)
  // → one history user turn with every tag + native part. Separate sends stay
  // separate role:user entries. Bot messages are never album-merged.
  const historyGroups = groupWhatsAppMessages(messages, {
    isBotAt: (m, mi) => isHistoryBotMessage(m, mi)
  });

  // Build each history entry (including its xAI upload) in parallel with
  // bounded concurrency, preserving chronological order in the result. Serial
  // uploads here used to dominate turn latency and could blow the history
  // fetch timeout when many recent messages carried media.
  // Scheduled + registry system messages carry no sender label: they are
  // rendered as <system-notification> turns, which already say who wrote them.
  const _meta = ({ senderName = null, isGemiX = false, isScheduled = false, isSystem = false }) => ({
    senderName,
    isGemiX,
    isScheduled,
    isSystem,
    isFromBot: isGemiX || isScheduled || isSystem,
    isSystemEvent: isScheduled || isSystem
  });

  /**
   * Who wrote a history message. The two accounts differ in one place only:
   * on the personal account a fromMe message that GemiX did not write is the
   * admin typing (Account Owner); on the dedicated account every fromMe is ours.
   * Program notices (release, music wrap, temp links, errors) are never the
   * admin — they carry a system prefix or the scheduled footer either way.
   */
  async function resolveHistorySenderMeta(msg, mi) {
    if (!msg.fromMe) {
      try {
        const contact = await msg.getContact();
        return _meta({ senderName: contact.pushname || contact.name || msg.from });
      } catch {
        return _meta({ senderName: msg.from || 'Unknown' });
      }
    }
    if (hasScheduledFooter(msg.body)) return _meta({ isScheduled: true });
    if (isSystemMessage(msg.body)) return _meta({ isSystem: true });
    if (platform === PLATFORM_WA_PERSONAL && !personalGemixFlags[mi]) {
      return _meta({ senderName: 'Account Owner' });
    }
    return _meta({ senderName: 'GemiX', isGemiX: true });
  }

  async function processHistoryGroup(group) {
    const groupMsgs = group.messages;
    const indices = [];
    for (let k = group.start; k < group.end; k++) indices.push(k);
    const primaryMi = indices[0];
    const primaryMsg = groupMsgs[0];
    const meta = await resolveHistorySenderMeta(primaryMsg, primaryMi);
    const { senderName, isGemiX, isFromBot, isSystemEvent } = meta;

    // Caption / special text only from the first non-empty body in the album
    // (WA puts the shared caption on one item, usually the first).
    let captionMsg = primaryMsg;
    for (const m of groupMsgs) {
      if ((m.body || '').trim()) { captionMsg = m; break; }
    }

    const ts = formatTimestamp(primaryMsg.timestamp * 1000);
    const mentionContacts = await _resolveMentionsForMessage(captionMsg, isGroup);
    let rawBody = _replaceMentionsInBody(captionMsg.body || '', mentionContacts);
    if (isGroup) {
      rawBody = await _resolveLidTagsInBody(rawBody, knownGroupPhones, lidTagCache);
    }
    let textContent = cleanIncomingText(rawBody);

    const specialText = formatSpecialMessageText(captionMsg);
    if (specialText !== null) {
      textContent = specialText;
    } else if (captionMsg.type === 'vcard' || captionMsg.type === 'multi_vcard') {
      textContent = formatWhatsAppContactText(captionMsg.body || textContent || '');
    } else if (captionMsg.type === 'poll_creation') {
      try {
        textContent = formatWhatsAppPollText(captionMsg, `[Poll] ${textContent || ''}`);
      } catch {
        textContent = '[Poll]';
      }
    }

    // Multi-attach album: ingest every item's media into this single turn.
    for (let gi = 0; gi < groupMsgs.length; gi++) {
      const msg = groupMsgs[gi];
      if (!msg.hasMedia || formatSpecialMessageText(msg) !== null) continue;

      const waFilename = msg._data?.filename;
      const resolvedName = _resolveWaFilename(waFilename, msg._data?.mimetype, msg.id?.id);
      const allFilenameHints = _attachmentFilenameHints(waFilename, resolvedName, null);
      if (gi === 0 || msg === captionMsg) {
        textContent = _stripRedundantAttachmentCaption(textContent, allFilenameHints);
      }

      // History is tags only, on every platform: the model opens what it needs
      // with read_file instead of the window carrying every past file (§8.6).
      const mediaIngress = await ingressWaMessageMedia(msg, userId, {
        workspaceId,
        inline: false
      });
      if (platform !== PLATFORM_WA_PERSONAL && isGemiX
          && (msg.type === 'audio' || msg.type === 'ptt') && mediaIngress.syncedPath) {
        resolveGemixVoiceTranscription(
          userId, mediaIngress.syncedPath, chat.id._serialized, (msg.timestamp || 0) * 1000
        );
      }
      textContent = _stripRedundantFilenameBesideAttachmentTag(
        textContent, mediaIngress.tag, allFilenameHints
      );
      textContent = `${textContent} ${mediaIngress.textFragment.trim()}`.trim();
      if (!textContent) {
        textContent = (mediaIngress.tag || buildAttachmentTag(resolvedName || msg._data?.filename || 'file')).trim();
      }
    }

    // Reply chain once per logical turn (first album item that quotes).
    const quoteMsg = groupMsgs.find(m => m.hasQuotedMsg) || null;
    if (quoteMsg) {
      try {
        const quoted = await processWhatsAppQuotedReply(
          quoteMsg,
          chat.id._serialized,
          userId,
          recentMessageIds,
          isGroup,
          platform,
          { includeQuotedMedia: false, workspaceId }
        );
        if (quoted.prefix) {
          textContent = `${quoted.prefix}${textContent || ''}`.trimEnd();
        }
      } catch (err) {
        log.warn(`History quote expand failed: ${err.message}`);
      }
    }

    if (!textContent) return null;

    // Emoji reactions on any album item (user or GemiX message) → inline tag.
    const reactionTag = await whatsAppReactionTagForMessages(groupMsgs);
    if (reactionTag) textContent = `${textContent} ${reactionTag}`.trim();

    // Program-to-user notices (scheduled reminders, release, temp links, error
    // banners) are ours only in the sense that our account sent them: GemiX did
    // not write them and they are not addressed to it. They go in as role:user
    // inside <system-notification> — as role:assistant the model read them as
    // its own past words. Only the timestamp is kept; the tag carries the rest.
    // GemiX's own replies stay unlabeled assistant turns.
    const finalText = isSystemEvent
      ? wrapSystemNotification(`[${ts}] ${textContent}`)
      : (isFromBot ? textContent : `[${ts}] ${senderName}: ${textContent}`);
    return {
      role: isFromBot && !isSystemEvent ? 'assistant' : 'user',
      content: finalText
    };
  }

  const built = await mapWithConcurrency(historyGroups, HISTORY_INGRESS_CONCURRENCY, processHistoryGroup);
  const historyMessages = built.filter(Boolean);

  return historyMessages;
}

/**
 * Send plain text to a WhatsApp chat with chunking and retry.
 * @param {object} chat
 * @param {string} text
 * @param {string[]} [mentions] - WhatsApp JIDs to tag as real @mentions (groups only)
 * @returns {Promise<void>}
 */
async function _sendTextWithRetry(chat, text, mentions = []) {
  const cleanedText = normalizeMarkdown(stripOutgoingDeliveryArtifacts(text));
  const chunkSize = 40000;
  const chunks = [];
  for (let i = 0; i < cleanedText.length; i += chunkSize) {
    chunks.push(cleanedText.slice(i, i + chunkSize));
  }
  const sendOptions = Array.isArray(mentions) && mentions.length > 0 ? { mentions } : undefined;
  for (const chunk of chunks) {
    let attempts = 3;
    while (attempts > 0) {
      try {
        await chat.sendMessage(chunk, sendOptions);
        break;
      } catch (err) {
        attempts--;
        if (attempts === 0) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

/**
 * Send response back to WhatsApp chat.
 * Handles text messages, voice messages, and file attachments.
 *
 * Outbound shape (whatsapp-web.js limits — one media per sendMessage):
 *   1. optional voice
 *   2. text (chunked if very long)
 *   3. each direct attachment as its own message
 *   4. optional link-fallback system message for oversized / failed / policy files
 *
 * Note: the mobile app can multi-select photos with caption(s); wwebjs cannot
 * send an album or N media in one frame. Caption-on-first-file was tried and
 * reverted: GemiX keeps text and files as separate messages (stable + clear).
 *
 * @param {object} chat - The whatsapp-web.js Chat object
 * @param {object} responseData - { text, voiceBuffer, isVoiceOnly, attachments, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId? }
 * @param {{ platform?: string }} [opts] - delivery context (platform drives mention filtering)
 * @returns {Promise<void>}
 */
async function sendWhatsAppResponse(chat, responseData, opts = {}) {
  const isPersonal = opts.platform === PLATFORM_WA_PERSONAL;
  const isGroup = Boolean(chat?.isGroup);
  // Strip the tags GemiX must never send (Meta AI everywhere; its own @gemix on
  // the personal account) and, in groups, turn the @<number> tags it kept into
  // real WhatsApp mentions.
  let outgoingMentions = [];
  if (typeof responseData.text === 'string' && responseData.text.trim()) {
    responseData.text = normalizeOutgoingMentionTags(responseData.text);
    responseData.text = stripDisallowedOutgoingMentions(responseData.text, { isPersonal });
    if (isGroup) outgoingMentions = collectMentionJids(responseData.text);
  }

  const hasText = typeof responseData.text === 'string' && responseData.text.trim().length > 0;
  const hasVoice = responseData.isVoiceOnly && responseData.voiceBuffer;
  const hasAttachments = Array.isArray(responseData.attachments) && responseData.attachments.length > 0;
  if (!hasText && !hasVoice && !hasAttachments) {
    throw new Error('Risposta WhatsApp vuota: nessun testo, voce o allegato da inviare');
  }

  if (hasVoice) {
    const media = new MessageMedia('audio/ogg', responseData.voiceBuffer.toString('base64'), 'voice.ogg');
    await chat.sendMessage(media, { sendAudioAsVoice: true });
    if (responseData.voiceTranscriptText) {
      storeRecentVoiceText(
        responseData.voiceTranscriptChatId || chat.id?._serialized,
        responseData.voiceTranscriptText
      );
    }
    const researchFooter = typeof responseData.researchFooter === 'string'
      ? responseData.researchFooter.trim()
      : '';
    if (researchFooter) {
      await _sendTextWithRetry(chat, researchFooter);
      log.info(`   Sent research badge after voice: ${researchFooter}`);
    }
    // Continue to send attachments below (don't return early)
  }

  if (hasText) {
    await _sendTextWithRetry(chat, responseData.text, outgoingMentions);
  }

  if (hasAttachments) {
    const sendAttachment = async (att) => {
      await sendWhatsAppAttachment(att, (media, options) => chat.sendMessage(media, options));
    };

    const result = await sendAttachmentsWithFallback(
      responseData.attachments,
      sendAttachment,
      { platform: PLATFORM.WHATSAPP }
    );

    log.info(`Attachment delivery: ${result.sent.length} direct, ${result.linkFallback.length} via link`);

    if (result.fallbackMessage) {
      try {
        // Retry on a transient detached/destroyed frame so the download link
        // still lands if the page recovers after a heavy attachment send.
        await withWaPuppeteerRetry(() => chat.sendMessage(result.fallbackMessage), { retries: 2, delayMs: 800 });
        log.info(`Sent link-fallback message for ${result.linkFallback.length} attachment(s)`);
      } catch (err) {
        log.error(`Failed to send fallback message: ${formatWaError(err)}`);
      }
    }
  }
}

/**
 * Process current message media: applies the audio/video duration limits and
 * returns the inline image part when the file is one. Everything else carries
 * its tag (plus any inline note) in `fragment` and waits for read_file.
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} userId - storage id for media sync
 * @param {object} [options] - { workspaceId, imagesInlined }
 * @returns {Promise<object|null>} { skipped, fragment?, filename?, syncedPath?, tag, contentParts? } or null
 */
async function processCurrentMedia(msg, userId, options = {}) {
  if (!msg.hasMedia) return null;

  const r = await ingressWaMessageMedia(msg, userId, {
    workspaceId: options.workspaceId || null,
    inline: true,
    imagesInlined: options.imagesInlined || 0
  });

  if (r.unsupported) {
    return { skipped: true, tag: r.tag, fragment: r.tag };
  }
  if (r.overDurationLimit) {
    return {
      skipped: true,
      tag: r.tag,
      fragment: r.textFragment.trim(),
      overDurationLimit: r.overDurationLimit
    };
  }
  if (r.contentParts.length > 0) {
    return {
      skipped: false,
      mimetype: r.mimetype,
      filename: r.filename,
      syncedPath: r.syncedPath,
      tag: r.tag,
      contentParts: r.contentParts
    };
  }
  // Tag-only (raw binary) or ingestion failure: the fragment carries the
  // tag and any "(error)" note for the model.
  return {
    skipped: true,
    tag: r.tag,
    fragment: r.textFragment.trim(),
    filename: r.filename,
    syncedPath: r.syncedPath
  };
}

/**
 * Build contentParts for one logical WA turn: a single message or a multi-
 * attachment album (several protocol messages, one UI send).
 * One labeled input_text (caption + all [Attachment] tags + reply chain once)
 * plus native input_image/input_file parts for every item.
 *
 * @param {object|object[]} msgOrMsgs - one Message or album Messages (oldest→newest)
 * @param {string} chatId
 * @param {string} userId - storage id for media sync
 * @param {boolean} [isGroup=false]
 * @param {string} [senderName='Unknown']
 * @param {string} [platform]
 * @param {Set<string>|null} [recentMessageIds]
 * @param {{ includeQuotedMedia?: boolean }} [options]
 * @returns {Promise<Array>}
 */
async function buildIncomingContentPartsFromMessages(
  msgOrMsgs,
  chatId,
  userId,
  isGroup = false,
  senderName = 'Unknown',
  platform = PLATFORM_WA_DEDICATED,
  recentMessageIds = null,
  options = {}
) {
  const messages = (Array.isArray(msgOrMsgs) ? msgOrMsgs : [msgOrMsgs]).filter(Boolean);
  if (messages.length === 0) return [];

  const includeQuotedMedia = options.includeQuotedMedia !== false;
  const contentParts = [];

  // Shared caption lives on one album item (usually the first with body).
  let captionMsg = messages[0];
  for (const m of messages) {
    if ((m.body || '').trim()) { captionMsg = m; break; }
  }
  const primaryMsg = messages[0];

  const mentionContacts = await _resolveMentionsForMessage(captionMsg, isGroup);
  let textBody = _replaceMentionsInBody(captionMsg.body || '', mentionContacts);
  if (isGroup) {
    const knownPhones = new Set();
    try {
      const chat = await captionMsg.getChat();
      if (Array.isArray(chat?.participants)) {
        for (const p of chat.participants) {
          if (p?.id?.server === 'c.us' && p.id.user) {
            const d = p.id.user.toString().replace(/\D/g, '');
            if (d) knownPhones.add(d);
          }
        }
      }
    } catch { /* best effort */ }
    textBody = await _resolveLidTagsInBody(textBody, knownPhones);
  }

  const specialText = formatSpecialMessageText(captionMsg);
  if (specialText !== null) {
    textBody = specialText;
  } else if (captionMsg.type === 'vcard' || captionMsg.type === 'multi_vcard') {
    textBody = formatWhatsAppContactText(captionMsg.body || textBody || '');
  } else if (captionMsg.type === 'poll_creation') {
    textBody = formatWhatsAppPollText(captionMsg, `[Poll] ${textBody}`);
  }

  const currentWorkspaceId = resolveChatWorkspaceId(platform, { id: { _serialized: chatId }, isGroup }, userId);

  // Reply chain once (first album item that is a reply).
  const quoteMsg = messages.find(m => m.hasQuotedMsg) || null;
  const recentIds = recentMessageIds
    || await getRecentWhatsAppMessageIds(quoteMsg || primaryMsg);
  if (quoteMsg) {
    const quotedContent = await processWhatsAppQuotedReply(
      quoteMsg, chatId, userId, recentIds, isGroup, platform,
      { includeQuotedMedia, workspaceId: currentWorkspaceId }
    );
    if (quotedContent && quotedContent.prefix) {
      textBody = quotedContent.prefix + textBody;
    }
    if (quotedContent && Array.isArray(quotedContent.mediaParts) && quotedContent.mediaParts.length > 0) {
      contentParts.push(...quotedContent.mediaParts);
    }
  }

  // Every media item in the logical message (album or single). Only these and
  // the quoted message may put an image in front of the model, up to the
  // per-turn cap (§8.6).
  let imagesInlined = contentParts.filter(p => p?.type === 'input_image').length;
  for (const msg of messages) {
    if (specialText !== null && msg === captionMsg) continue;
    const mediaResult = specialText === null
      ? await processCurrentMedia(msg, userId, { workspaceId: currentWorkspaceId, imagesInlined })
      : null;
    if (mediaResult?.contentParts?.length) {
      imagesInlined += mediaResult.contentParts.filter(p => p?.type === 'input_image').length;
    }
    const waFilename = msg._data?.filename;
    if (mediaResult) {
      if (mediaResult.skipped) {
        textBody = `${textBody} ${mediaResult.fragment || mediaResult.tag}`.trim();
      } else {
        contentParts.push(...mediaResult.contentParts);
        textBody = `${textBody} ${mediaResult.tag}`.trim();
      }
      if (textBody) {
        const hints = _attachmentFilenameHints(waFilename, mediaResult.filename, mediaResult.syncedPath);
        textBody = _stripRedundantAttachmentCaption(textBody, hints);
        if (mediaResult.tag) {
          textBody = _stripRedundantFilenameBesideAttachmentTag(textBody, mediaResult.tag, hints);
        }
      }
    } else if (msg.hasMedia && specialText === null) {
      const tag = buildAttachmentTag(msg._data?.filename || 'file');
      textBody = `${tag} (file unavailable) ${textBody}`.trim();
    } else if (waFilename) {
      textBody = _stripRedundantAttachmentCaption(textBody, [waFilename]);
    }
  }

  if (!textBody.trim() && quoteMsg && contentParts.length === 0) {
    textBody = '[In reply to a message]\n';
  }

  // Emoji reactions on the current message (or any album item) → inline tag.
  const reactionTag = await whatsAppReactionTagForMessages(messages);
  if (reactionTag) textBody = `${textBody} ${reactionTag}`.trim();

  if (textBody.trim()) {
    const tsMs = (primaryMsg.timestamp || 0) * 1000;
    contentParts.unshift({
      type: 'text',
      text: formatLabeledUserContent(tsMs, senderName, textBody.trim())
    });
  }

  return contentParts;
}

/** True when the message should enter the batch pipeline (incl. quote-only, like Discord). */
function waMessageHasUsableContent(msg) {
  if (!msg) return false;
  if (msg.hasMedia) return true;
  if (msg.hasQuotedMsg) return true;
  if (msg.body && String(msg.body).trim()) return true;
  if (msg.type === 'vcard' || msg.type === 'multi_vcard' || msg.type === 'poll_creation') return true;
  if (isSpecialNonMediaMessage(msg)) return true;
  return false;
}

export {
  buildWhatsAppHistory,
  buildIncomingContentPartsFromMessages,
  sendWhatsAppResponse,
  getRecentWhatsAppMessageIds,
  waMessageHasUsableContent,
  _waMessageKey

};
