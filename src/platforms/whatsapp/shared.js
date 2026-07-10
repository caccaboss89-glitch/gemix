// src/platforms/whatsapp/shared.js
//
// Shared WhatsApp logic used by both dedicated.js and personal.js.
// Builds history, handles incoming media/quoted messages, processes
// current message attachments, and sends responses (text and/or voice on
// WA dedicated, plus file attachments). Central place for WhatsApp-specific
// formatting and media handling.

const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL, PLATFORM_WA_DEDICATED } = require('../../config/constants');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { isSpecialNonMediaMessage, formatSpecialMessageText, formatWhatsAppContactText } = require('../../utils/waSpecialMessages');
const { formatTimestamp } = require('../../utils/time');
const { hasScheduledFooter } = require('../../utils/footer');
const { buildPersonalGemixFlags } = require('../../utils/personalWaHistory');
const { isSystemMessage } = require('../../config/systemMessages');

const { buildAttachmentTag } = require('../../utils/media');
const { MAX_IMAGE_READS, MAX_FILE_READS, classifyAiFileDelivery, DELIVERY_MODE } = require('../../utils/aiFileDelivery');
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
const { mapWithConcurrency } = require('../../utils/concurrency');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WhatsAppResponse');

// Max parallel xAI uploads while building one history window. Uploads are
// already bounded to MAX_HISTORY_MEDIA_IMAGES/FILES per turn by the pre-upload
// budget pass (see constants.js).
const HISTORY_UPLOAD_CONCURRENCY = 15;

const { resolveIngressFilename: _resolveWaFilename } = require('../../utils/attachmentFilenames');

function _waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

// Mention handling: rewrite the @<id> tags WhatsApp encodes in a body into
// @<phone-number> (resolving @lid ids to the real number) so the model never
// sees a raw @lid and can map each tag to a name via <Participants>; plus the
// outgoing helpers that strip disallowed tags and collect mention JIDs.
// See utils/waMentions.js.
const {
  replaceMentionsInBody: _replaceMentionsInBody,
  resolveMentionsForMessage: _resolveMentionsForMessage,
  resolveLidTagsInBody: _resolveLidTagsInBody,
  stripDisallowedOutgoingMentions,
  normalizeOutgoingMentionTags,
  collectMentionJids,
} = require('../../utils/waMentions');
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

  // True when a history message is GemiX/system/scheduled (assistant role, which
  // cannot carry native parts → always tag-only). On dedicated every fromMe is
  // bot; on personal only the GemiX-flagged fromMe is (Account Owner is a user).
  const isHistoryBotMessage = (msg, mi) => (platform === PLATFORM_WA_PERSONAL
    ? Boolean(msg.fromMe && personalGemixFlags && personalGemixFlags[mi])
    : Boolean(msg.fromMe));

  // Pre-upload budget pass (newest→oldest, per message with media on WA):
  // only the newest MAX_IMAGE_READS image messages and MAX_FILE_READS file
  // messages may upload to xAI; the rest stay tag-only and are never uploaded.
  // (Discord allocates budget per attachment — see discord/client.js.)
  const uploadAllowed = new Array(messages.length).fill(false);
  {
    let imgBudget = MAX_IMAGE_READS;
    let fileBudget = MAX_FILE_READS;
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (!msg.hasMedia) continue;
      if (formatSpecialMessageText(msg) !== null) continue; // location/event: no upload
      if (isHistoryBotMessage(msg, mi)) continue; // assistant entries are tag-only anyway
      const waFilename = msg._data?.filename;
      const resolvedName = _resolveWaFilename(waFilename, msg._data?.mimetype, msg.id?.id);
      const mode = classifyAiFileDelivery(resolvedName || waFilename || 'file', msg._data?.mimetype || '');
      if (mode === DELIVERY_MODE.IMAGE) {
        if (imgBudget > 0) { imgBudget--; uploadAllowed[mi] = true; }
      } else if (mode === DELIVERY_MODE.FILE) {
        if (fileBudget > 0) { fileBudget--; uploadAllowed[mi] = true; }
      }
      // TAG_ONLY (raw binaries): never uploaded, no budget consumed.
    }
  }

  // Build each history entry (including its xAI upload) in parallel with
  // bounded concurrency, preserving chronological order in the result. Serial
  // uploads here used to dominate turn latency and could blow the history
  // fetch timeout when many recent messages carried media.
  async function processHistoryMessage(msg, mi) {
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
    let rawBody = _replaceMentionsInBody(msg.body || '', mentionContacts);
    if (isGroup) {
      rawBody = await _resolveLidTagsInBody(rawBody, knownGroupPhones, lidTagCache);
    }
    let textContent = cleanIncomingText(rawBody);

    const specialText = formatSpecialMessageText(msg);
    if (specialText !== null) {
      // Location / scheduled event: data-only messages. Use the parsed text and
      // never ingest the raw payload (e.g. a location's base64 map thumbnail).
      textContent = specialText;
    } else if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
      textContent = formatWhatsAppContactText(msg.body || textContent || '');
    } else if (msg.type === 'poll_creation') {
      try {
        // Use the LID-resolved body as the question base (mentions in a poll
        // question are rare but must not regress to raw @lid).
        textContent = formatWhatsAppPollText(msg, `[Poll] ${textContent || ''}`);
      } catch {
        textContent = '[Poll]';
      }
    }

    let mediaParts = [];
    if (msg.hasMedia && specialText === null) {
      const waFilename = msg._data?.filename;
      const resolvedName = _resolveWaFilename(waFilename, msg._data?.mimetype, msg.id?.id);
      const allFilenameHints = _attachmentFilenameHints(waFilename, resolvedName, null);
      textContent = _stripRedundantAttachmentCaption(textContent, allFilenameHints);

      // Main brain sees every recent history file directly: user-role entries
      // carry native parts (input_file/input_image via public URL). Assistant
      // entries (GemiX's own) stay [Attachment] tags only — that role cannot
      // carry input parts. Past voice transcript text is injected as
      // <PastVoiceReply> on the current turn (handler.js).
      // Over the per-call media budget (uploadAllowed[mi] === false) we also
      // force tag-only so the file is never uploaded to xAI.
      const overBudget = !isFromBot && !uploadAllowed[mi];
      const mediaIngress = await ingressWaMessageMedia(msg, userId, {
        tagOnly: isFromBot || overBudget,
      });
      // GemiX voice messages: persist spoken text into history_meta so the
      // handler can inject <PastVoiceReply> blocks on the current turn.
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
      if (overBudget && !textContent.includes('not shown this turn')) {
        textContent = `${textContent} (older media, not shown this turn — newest ${MAX_IMAGE_READS} image messages + ${MAX_FILE_READS} file messages on WhatsApp; ask to resend or reply to view)`.trim();
      }
      if (!textContent) {
        textContent = (mediaIngress.tag || buildAttachmentTag(null, resolvedName || msg._data?.filename || 'file')).trim();
      }
      mediaParts = mediaIngress.contentParts || [];
    }

    if (!textContent) return null;

    const prefix = `[${ts}] ${senderName}: `;

    // For normal GemiX assistant replies: bare textContent (role assistant)
    // For real users: labeled prefix (role user)
    // For system events: labeled prefix including [System] tag (role assistant)
    const useLabeledContent = !isFromBot || isSystemEvent;
    const finalText = useLabeledContent ? `${prefix}${textContent}` : textContent;
    return {
      role: isFromBot ? 'assistant' : 'user',
      content: mediaParts.length > 0
        ? [{ type: 'text', text: finalText }, ...mediaParts]
        : finalText,
    };
  }

  const built = await mapWithConcurrency(messages, HISTORY_UPLOAD_CONCURRENCY, processHistoryMessage);
  const historyMessages = built.filter(Boolean);

  // Bound the cost of re-attached history media: newest images + newest files.
  capHistoryImageParts(historyMessages, MAX_IMAGE_READS, MAX_FILE_READS);

  return historyMessages;
}

/**
 * Extract quoted message content if this message is a reply.
 * Handles media (images, video, audio with duration limits, documents).
 * and plain quoted text. Uses recentMessageIds to decide whether the quoted
 * message is still inside the loaded history window.
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
 * Build audio/video and oversized files use temp download links; other media try direct send first, then temp links on failure.
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
    await _sendTextWithRetry(chat, responseData.text, outgoingMentions);
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
  if (isGroup) {
    // Second-level LID resolution for any @<digits> tag getMentions missed.
    // knownPhones (group roster) skips redundant lookups for real phone tags.
    const knownPhones = new Set();
    try {
      const chat = await msg.getChat();
      if (Array.isArray(chat?.participants)) {
        for (const p of chat.participants) {
          if (p?.id?.server === 'c.us' && p.id.user) {
            const d = p.id.user.toString().replace(/\D/g, '');
            if (d) knownPhones.add(d);
          }
        }
      }
    } catch { /* best effort: resolve all tags */ }
    textBody = await _resolveLidTagsInBody(textBody, knownPhones);
  }

  const waFilename = msg._data?.filename;
  if (waFilename) {
    textBody = _stripRedundantAttachmentCaption(textBody, [waFilename]);
  }

  const specialText = formatSpecialMessageText(msg);
  if (specialText !== null) {
    textBody = specialText;
  } else if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    textBody = formatWhatsAppContactText(msg.body || textBody || '');
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

  // Special data-only messages (location, event) never ingest their raw
  // payload (e.g. a location's base64 map thumbnail).
  const mediaResult = specialText === null ? await processCurrentMedia(msg, userId) : null;
  if (mediaResult) {
    if (mediaResult.skipped) {
      textBody = `${textBody} ${mediaResult.fragment || mediaResult.tag}`.trim();
    } else {
      contentParts.push(...mediaResult.contentParts);
      textBody = `${textBody} ${mediaResult.tag}`.trim();
    }
  } else if (msg.hasMedia && specialText === null) {
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
  if (isSpecialNonMediaMessage(msg)) return true;
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
