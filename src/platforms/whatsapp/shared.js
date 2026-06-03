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
const {
  classifyAiFileDelivery,
  DELIVERY_MODE,
  deliverSyncedAttachment,
  hasIngressTextFragment,
  hasInlineFileContent,
} = require('../../utils/aiFileDelivery');
const { resolveGemixVoiceTranscription } = require('../../utils/historySync');
const { ingressWaMessageMedia } = require('../../utils/incomingMediaIngress');
const {
  normalizeMarkdown,
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
 * `@233079671120038`); the human-readable name lives in the contact metadata
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

    if (msg.hasMedia) {
      const waFilename = msg._data?.filename;
      const resolvedName = _resolveWaFilename(waFilename, msg._data?.mimetype, msg.id?.id);
      const allFilenameHints = _attachmentFilenameHints(waFilename, resolvedName, null);
      textContent = _stripRedundantAttachmentCaption(textContent, allFilenameHints);

      const mediaIngress = await ingressWaMessageMedia(msg, userId, {
        chatId: chat.id._serialized,
        isGemixVoice: platform !== PLATFORM_WA_PERSONAL && isGemiX,
        historyTagOnly: true,
      });
      textContent = _stripRedundantFilenameBesideAttachmentTag(
        textContent, mediaIngress.tag, allFilenameHints,
      );
      textContent = `${textContent} ${mediaIngress.textFragment.trim()}`.trim();
      if (!textContent) {
        textContent = (mediaIngress.tag || buildAttachmentTag(null, resolvedName || msg._data?.filename || 'file')).trim();
      }
    }

    if (!textContent) continue;

    const prefix = `[${ts}] ${senderName}: `;

    // For normal GemiX assistant replies: bare textContent (role assistant)
    // For real users: labeled prefix (role user)
    // For system events: labeled prefix including [System] tag (role assistant)
    const useLabeledContent = !isFromBot || isSystemEvent;
    historyMessages.push({
      role: isFromBot ? 'assistant' : 'user',
      content: useLabeledContent ? `${prefix}${textContent}` : textContent,
    });
  }

  return historyMessages;
}

/**
 * Extract quoted message content if this message is a reply.
 * Handles media (images, video, audio with transcription/duration, PDF if in recent history)
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
 * Send response back to WhatsApp chat.
 * Handles text messages, voice messages, and file attachments.
 * Attachments that fail to send are automatically uploaded to temporary server.
 * @param {object} chat - The whatsapp-web.js Chat object
 * @param {object} responseData - Response data { text, voiceBuffer, isVoiceOnly, attachments }
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
    // Continue to send attachments below (don't return early)
  }

  if (hasText) {
    const cleanedText = normalizeMarkdown(responseData.text);
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
 * Process current message media: applies duration limits for audio/video,
 * inlines text/code documents as <FileContent>, and returns tags or buffers
 * for supported media.
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} userId - storage id for media sync
 * @returns {Promise<object|null>} { skipped, buffer?, mimetype?, filename?, tag, reason? } or null
 */
async function processCurrentMedia(msg, userId, opts = {}) {
  if (!msg.hasMedia) return null;

  const { chatId, isGemixVoice = false } = opts;
  const r = await ingressWaMessageMedia(msg, userId, { chatId, isGemixVoice });
  const frag = r.textFragment.trim();

  if (r.unsupported) {
    return { skipped: true, tag: r.tag, reason: null };
  }
  if (hasIngressTextFragment(frag)) {
    return { skipped: true, tag: r.tag, reason: null, inlineText: frag };
  }
  if (r.overDurationLimit) {
    return {
      skipped: true,
      tag: r.tag,
      reason: r.durationNote || `${r.overDurationLimit} too long`,
      overDurationLimit: r.overDurationLimit,
    };
  }

  if (r.contentParts.length > 0) {
    return {
      skipped: false,
      buffer: null,
      mimetype: r.mimetype,
      filename: r.filename,
      syncedPath: r.syncedPath,
      tag: r.tag,
      contentParts: r.contentParts,
    };
  }

  if (msg.type === 'document' && !hasInlineFileContent(frag)) {
    const docMode = classifyAiFileDelivery(r.filename || msg._data?.filename || 'file', r.mimetype || '');
    if (docMode === DELIVERY_MODE.TAG_ONLY) {
      return { skipped: true, tag: r.tag, reason: null };
    }
  }

  if (!r.fetchBuffer) {
    return { skipped: true, tag: r.tag, reason: 'file unavailable' };
  }

  let buffer = null;
  try {
    buffer = await r.fetchBuffer();
  } catch { /* ignore */ }

  if (!buffer) {
    return { skipped: true, tag: r.tag, reason: 'file unavailable' };
  }

  return {
    skipped: false,
    buffer,
    mimetype: r.mimetype,
    filename: r.filename,
    syncedPath: r.syncedPath,
    tag: r.tag,
    contentParts: [],
    fetchBuffer: r.fetchBuffer,
    isGemixVoice,
  };
}

/**
 * Build the contentParts array for an incoming WhatsApp message.
 * Handles vcard/poll text formatting, quoted message content, and current message media.
 *
 * For text/code documents on the *current* message we inline the content as <FileContent>
 * (replacing the [Attachment] tag) so the model sees it immediately without needing read_file.
 * Pure-attachment sends (no caption) have redundant filename bodies cleaned.
 *
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - The chat's serialized ID (for voice cache lookup)
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

  const isGemixCurrentTurn = platform !== PLATFORM_WA_PERSONAL && msg.fromMe
    && !hasScheduledFooter(msg.body)
    && !isSystemMessage(msg.body);
  const mediaResult = await processCurrentMedia(msg, userId, {
    chatId,
    isGemixVoice: isGemixCurrentTurn,
  });
  if (mediaResult) {
    if (mediaResult.skipped && mediaResult.inlineText) {
      const caption = textBody ? ` ${textBody}` : '';
      textBody = `${mediaResult.inlineText}${caption}`.trim();
    } else if (mediaResult.skipped) {
      const suffix = mediaResult.reason ? ` (${mediaResult.reason})` : '';
      textBody = `${mediaResult.tag}${suffix} ${textBody}`.trim();
    } else {
      if (mediaResult.contentParts?.length) {
        contentParts.push(...mediaResult.contentParts);
      } else if (mediaResult.fetchBuffer) {
        const isAudioType = msg.type === 'audio' || msg.type === 'ptt';
        const retry = await deliverSyncedAttachment({
          syncedPath: mediaResult.syncedPath,
          name: mediaResult.filename || 'file',
          contentType: mediaResult.mimetype || '',
          historyStorageId: userId,
          fetchBuffer: mediaResult.fetchBuffer,
          ownerKey: userId,
          metadataDurationSec: Number(msg.duration || msg._data?.duration || 0),
          getVoiceTranscription: isGemixCurrentTurn && isAudioType
            ? async () => resolveGemixVoiceTranscription(
              userId, mediaResult.syncedPath, chatId, (msg.timestamp || 0) * 1000,
            )
            : null,
        });
        if (retry.contentParts?.length) {
          contentParts.push(...retry.contentParts);
        }
      }
      textBody = `${mediaResult.tag} ${textBody}`.trim();
    }
  } else if (msg.hasMedia) {
    const tag = buildAttachmentTag(null, msg._data?.filename || 'file');
    textBody = `${tag} (file unavailable) ${textBody}`.trim();
  }

  if (mediaResult && textBody && !mediaResult.inlineText) {
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
