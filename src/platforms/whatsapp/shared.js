// src/platforms/whatsapp/shared.js
//
// Shared WhatsApp logic used by both dedicated.js and personal.js.
// Builds history, handles incoming media/quoted messages, processes
// current message attachments, and sends responses (text + voice + files).
// Central place for WhatsApp-specific formatting and media handling.

const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { formatTimestamp } = require('../../utils/time');
const { hasScheduledFooter } = require('../../utils/footer');
const { buildPersonalGemixFlags } = require('../../utils/personalWaHistory');
const { isSystemMessage } = require('../../config/systemMessages');

const { buildAttachmentTag } = require('../../utils/media');
const { MAX_IMAGE_READS } = require('../../utils/aiFileDelivery');
const { resolveGemixVoiceTranscription, storeRecentVoiceText } = require('../../utils/historySync');
const { ingressWaMessageMedia, capHistoryImageParts } = require('../../utils/incomingMediaIngress');
const {
  normalizeMarkdown,
  stripOutgoingDeliveryArtifacts,
  cleanIncomingText,
  formatLabeledUserContent,
} = require('../../utils/text');
const {
  attachmentFilenameHints: _attachmentFilenameHints,
  stripRedundantAttachmentCaption: _stripRedundantAttachmentCaption,
  stripRedundantFilenameBesideAttachmentTag: _stripRedundantFilenameBesideAttachmentTag,
} = require('../../utils/attachmentCaption');

const { toWhatsAppMediaArgs } = require('../../utils/attachments');
const { sendAttachmentsWithFallback } = require('../../utils/attachmentFallback');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WhatsAppResponse');

const { resolveIngressFilename: _resolveWaFilename } = require('../../utils/attachmentFilenames');

function _waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

/**
 * Replace WhatsApp @<digits> mention tags inside a body with @<DisplayName>
 * so the AI can understand who is being mentioned.
 *
 * WhatsApp encodes mentions in `msg.body` as `@<phone-digits>` (e.g.
 * `@390000000000000`); the human-readable name lives in the contact metadata
 * fetched via `msg.getMentions()`. We resolve each numeric tag to the best
 * available display name with the following priority:
 *
 *   1. contact.pushname  -> public profile name the contact set on their own
 *                          WhatsApp profile. Preferred because it's how the
 *                          person presents themselves and is consistent for
 *                          everyone reading the chat.
 *   2. contact.name      -> name as saved in the OWNER's phone address book
 *                          (only set when the contact is in rubrica AND has
 *                          been synced via Multi-Device).
 *   3. contact.shortName -> the abbreviated form of `name` (rare, but useful
 *                          when neither pushname nor full name are available).
 *   4. contact.number    -> formatted phone number.
 *   5. contact.id.user   -> raw digits, last-resort fallback.
 *
 * There is no single getFormattedName()-style helper in whatsapp-web.js;
 * the priority must be coded manually. See https://docs.wwebjs.dev/Contact.html.
 *
 * Falls through silently when mentions can't be resolved (e.g. group
 * membership data unavailable) - the original numeric tag is kept.
 *
 * @param {string} body - raw msg.body
 * @param {Array} contacts - resolved Contact objects from msg.getMentions()
 * @returns {string}
 */
const { replaceMentionsInBody: _replaceMentionsInBody, resolveMentionsForMessage: _resolveMentionsForMessage } = require('../../utils/waMentions');
const { processWhatsAppQuotedReply } = require('../../utils/quoteIngress');

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
  const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
  let messages = rawMessages.slice(-MAX_HISTORY);

  // Exclude current message(s) being processed (they form the final user turn and are omitted from the history array)
  if (excludeKeys) {
    const toExclude = excludeKeys instanceof Set ? excludeKeys : new Set([excludeKeys]);
    messages = messages.filter(m => {
      const k = _waMessageKey(m);
      return !k || !toExclude.has(k);
    });
  }

  const isGroup = Boolean(chat?.isGroup);

  const historyMessages = [];
  const personalGemixFlags = platform === PLATFORM_WA_PERSONAL
    ? buildPersonalGemixFlags(messages)
    : null;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    let senderName;
    let isGemiX = false;
    let isScheduled = false;
    let isSystem = false;

    if (platform === PLATFORM_WA_PERSONAL) {
      if (msg.fromMe) {
        if (personalGemixFlags[mi]) {
          senderName = 'GemiX';
          isGemiX = true;
        } else {
          senderName = 'Account Owner';
        }
      } else {
        try {
          const contact = await msg.getContact();
          senderName = contact.pushname || contact.name || msg.from;
        } catch {
          senderName = msg.from || 'Unknown';
        }
      }
    } else {
      // [System] tagging (for scheduled/system messages) is limited to the dedicated
      // platform in private (non-group) chats; personal platform uses GemiX/Account Owner.
      if (msg.fromMe) {
        const isPrivateDedicated = !isGroup;
        if (isPrivateDedicated && hasScheduledFooter(msg.body)) {
          senderName = '[System]';
          isScheduled = true;
        } else if (isPrivateDedicated && isSystemMessage(msg.body)) {
          senderName = '[System]';
          isSystem = true;
        } else {
          senderName = 'GemiX';
          isGemiX = true;
        }
      } else {
        try {
          const contact = await msg.getContact();
          senderName = contact.pushname || contact.name || msg.from;
        } catch {
          senderName = msg.from || 'Unknown';
        }
      }
    }

    const isFromBot = isGemiX || isScheduled || isSystem;
    const isSystemEvent = isScheduled || isSystem;

    const ts = formatTimestamp(msg.timestamp * 1000);
    const mentionContacts = await _resolveMentionsForMessage(msg, isGroup);
    const rawBody = _replaceMentionsInBody(msg.body || '', mentionContacts);
    let textContent = cleanIncomingText(rawBody);

    if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
      textContent = `[Shared contact] ${textContent || ''}`;
    } else if (msg.type === 'poll_creation') {
      try {
        textContent = formatWhatsAppPollText(msg, `[Poll] ${msg.body || ''}`);
      } catch {
        textContent = '[Poll]';
      }
    }

    let mediaParts = [];
    if (msg.hasMedia) {
      const waFilename = msg._data?.filename;
      const resolvedName = _resolveWaFilename(waFilename, msg._data?.mimetype, msg.id?.id);
      const allFilenameHints = _attachmentFilenameHints(waFilename, resolvedName, null);
      textContent = _stripRedundantAttachmentCaption(textContent, allFilenameHints);

      // History: [Attachment] tags only (no native re-upload). Native parts are
      // reserved for the current user turn and GemiX voice transcript files.
      const mediaIngress = await ingressWaMessageMedia(msg, userId, {
        tagOnly: true,
      });
      // GemiX voice messages: persist the transcription into history meta so
      // the handler can attach the transcript file to the current turn.
      if (platform !== PLATFORM_WA_PERSONAL && isGemiX
          && (msg.type === 'audio' || msg.type === 'ptt') && mediaIngress.syncedPath) {
        resolveGemixVoiceTranscription(
          userId, mediaIngress.syncedPath, chat.id._serialized, (msg.timestamp || 0) * 1000,
        );
      }
      textContent = _stripRedundantFilenameBesideAttachmentTag(
        textContent, mediaIngress.tag, allFilenameHints,
      );
      textContent = `${textContent} ${mediaIngress.textFragment.trim()}`.trim();
      if (!textContent) {
        textContent = (mediaIngress.tag || buildAttachmentTag(null, resolvedName || msg._data?.filename || 'file')).trim();
      }
      mediaParts = mediaIngress.contentParts || [];
    }

    if (!textContent) continue;

    const prefix = `[${ts}] ${senderName}: `;

    // For normal GemiX assistant replies: bare textContent (role assistant)
    // For real users: labeled prefix (role user)
    // For system events: labeled prefix including [System] tag (role assistant)
    const useLabeledContent = !isFromBot || isSystemEvent;
    const finalText = useLabeledContent ? `${prefix}${textContent}` : textContent;
    historyMessages.push({
      role: isFromBot ? 'assistant' : 'user',
      content: mediaParts.length > 0
        ? [{ type: 'text', text: finalText }, ...mediaParts]
        : finalText,
    });
  }

  // Bound the vision cost of re-attached history images (newest kept).
  capHistoryImageParts(historyMessages, MAX_IMAGE_READS);

  return historyMessages;
}

/**
 * Extract quoted message content if this message is a reply.
 * Handles media (images, video, audio with duration limits, documents).
 * and plain quoted text. Uses recentMessageIds to decide PDF media inclusion.
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - The chat's serialized ID (for voice cache lookup)
 * @param {string} userId - storage id for media sync
 * @param {Set<string>} recentMessageIds - keys of recent messages (to gate PDF content)
 * @param {boolean} [isGroup=false] - whether the chat is a group (affects mention resolution)
 * @returns {Promise<object>} { prefix: string, mediaParts: array }
 */
async function extractQuotedMessageContent(msg, chatId, userId, recentMessageIds, isGroup = false, platform = PLATFORM_WA_DEDICATED) {
  return processWhatsAppQuotedReply(msg, chatId, userId, recentMessageIds, isGroup, platform);
}

/**
 * Send plain text to a WhatsApp chat with chunking and retry.
 * @param {object} chat
 * @param {string} text
 * @returns {Promise<void>}
 */
async function _sendTextWithRetry(chat, text) {
  const cleanedText = normalizeMarkdown(stripOutgoingDeliveryArtifacts(text));
  const chunkSize = 40000;
  const chunks = [];
  for (let i = 0; i < cleanedText.length; i += chunkSize) {
    chunks.push(cleanedText.slice(i, i + chunkSize));
  }
  for (const chunk of chunks) {
    let attempts = 3;
    while (attempts > 0) {
      try {
        await chat.sendMessage(chunk);
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
 * Build audio/video and oversized files use temp download links; other media try direct send first, then temp links on failure.
 * @param {object} chat - The whatsapp-web.js Chat object
 * @param {object} responseData - Response data { text, voiceBuffer, isVoiceOnly, attachments, researchFooter? }
 * @returns {Promise<void>}
 */
async function sendWhatsAppResponse(chat, responseData) {
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
        responseData.voiceTranscriptText,
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
    await _sendTextWithRetry(chat, responseData.text);
  }

  if (hasAttachments) {
    // Try to send attachments with fallback support
    const sendAttachment = async (att) => {
      const m = toWhatsAppMediaArgs(att);
      if (!m) {
        throw new Error(`Cannot convert attachment to WhatsApp media: ${att.name || 'unknown'}`);
      }
      const media = new MessageMedia(m.mimetype, m.base64, m.name);
      const options = {};
      if (att.sendAudioAsVoice) {
        options.sendAudioAsVoice = true;
      }
      await chat.sendMessage(media, options);
    };

    const result = await sendAttachmentsWithFallback(
      responseData.attachments,
      sendAttachment,
      { platform: 'whatsapp' }
    );

    log.info(`Attachment delivery: ${result.sent.length} sent, ${result.failed.length} failed`);

    // If there were fallback links, send the system message with download link
    if (result.fallbackMessage) {
      try {
        await chat.sendMessage(result.fallbackMessage);
        log.info(`Sent fallback message with temp download links for ${result.failed.length} attachment(s)`);
      } catch (err) {
        log.error(`Failed to send fallback message: ${err.message}`);
      }
    }
  }
}

/**
 * Process current message media: applies duration limits for audio/video and
 * returns native content parts (input_image / input_file via public URL) for
 * supported media. Skipped media carries its tag (plus any inline note) in
 * `fragment`.
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} userId - storage id for media sync
 * @returns {Promise<object|null>} { skipped, fragment?, filename?, syncedPath?, tag, contentParts? } or null
 */
async function processCurrentMedia(msg, userId) {
  if (!msg.hasMedia) return null;

  const r = await ingressWaMessageMedia(msg, userId, {});

  if (r.unsupported) {
    return { skipped: true, tag: r.tag, fragment: r.tag };
  }
  if (r.overDurationLimit) {
    return {
      skipped: true,
      tag: r.tag,
      fragment: r.textFragment.trim(),
      overDurationLimit: r.overDurationLimit,
    };
  }
  if (r.contentParts.length > 0) {
    return {
      skipped: false,
      mimetype: r.mimetype,
      filename: r.filename,
      syncedPath: r.syncedPath,
      tag: r.tag,
      contentParts: r.contentParts,
    };
  }
  // Tag-only (raw binary) or ingestion failure: the fragment carries the
  // tag and any "(error)" note for the model.
  return {
    skipped: true,
    tag: r.tag,
    fragment: r.textFragment.trim(),
    filename: r.filename,
    syncedPath: r.syncedPath,
  };
}

/**
 * Build the contentParts array for an incoming WhatsApp message.
 * Handles vcard/poll text formatting, quoted message content, and current
 * message media (attached natively as input_image / input_file parts).
 * Pure-attachment sends (no caption) have redundant filename bodies cleaned.
 *
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - The chat's serialized ID
 * @param {string} userId - storage id for media sync
 * @param {boolean} [isGroup=false] - whether chat is group (affects mentions)
 * @param {string} [senderName='Unknown'] - display name for the message author
 * @returns {Promise<Array>} contentParts array (may be empty if message has no usable content)
 */
async function buildIncomingContentParts(msg, chatId, userId, isGroup = false, senderName = 'Unknown', platform = PLATFORM_WA_DEDICATED, recentMessageIds = null) {
  const contentParts = [];
  const mentionContacts = await _resolveMentionsForMessage(msg, isGroup);
  let textBody = _replaceMentionsInBody(msg.body || '', mentionContacts);

  const waFilename = msg._data?.filename;
  if (waFilename) {
    textBody = _stripRedundantAttachmentCaption(textBody, [waFilename]);
  }

  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    textBody = `[Shared contact] ${textBody}`;
  } else if (msg.type === 'poll_creation') {
    textBody = formatWhatsAppPollText(msg, `[Poll] ${textBody}`);
  }

  const recentIds = recentMessageIds || await getRecentWhatsAppMessageIds(msg);
  const quotedContent = await extractQuotedMessageContent(msg, chatId, userId, recentIds, isGroup, platform);
  if (quotedContent && quotedContent.prefix) {
    textBody = quotedContent.prefix + textBody;
  }
  if (quotedContent && Array.isArray(quotedContent.mediaParts) && quotedContent.mediaParts.length > 0) {
    contentParts.push(...quotedContent.mediaParts);
  }

  const mediaResult = await processCurrentMedia(msg, userId);
  if (mediaResult) {
    if (mediaResult.skipped) {
      textBody = `${mediaResult.fragment || mediaResult.tag} ${textBody}`.trim();
    } else {
      contentParts.push(...mediaResult.contentParts);
      textBody = `${mediaResult.tag} ${textBody}`.trim();
    }
  } else if (msg.hasMedia) {
    const tag = buildAttachmentTag(null, msg._data?.filename || 'file');
    textBody = `${tag} (file unavailable) ${textBody}`.trim();
  }

  if (mediaResult && textBody) {
    const hints = _attachmentFilenameHints(waFilename, mediaResult.filename, mediaResult.syncedPath);
    textBody = _stripRedundantAttachmentCaption(textBody, hints);
    if (mediaResult.tag) {
      textBody = _stripRedundantFilenameBesideAttachmentTag(textBody, mediaResult.tag, hints);
    }
  }

  if (!textBody.trim() && msg.hasQuotedMsg && contentParts.length === 0) {
    textBody = '[In reply to a message]\n';
  }

  if (textBody.trim()) {
    const tsMs = (msg.timestamp || 0) * 1000;
    contentParts.unshift({ type: 'text', text: formatLabeledUserContent(tsMs, senderName, textBody.trim()) });
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
  return false;
}

module.exports = {
  buildWhatsAppHistory,
  buildIncomingContentParts,
  sendWhatsAppResponse,
  getRecentWhatsAppMessageIds,
  waMessageHasUsableContent,
  _waMessageKey,
};
