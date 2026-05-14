// src/platforms/whatsapp/shared.js
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL, MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S } = require('../../config/constants');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { formatTimestamp } = require('../../utils/time');
const { hasFooter, removeFooter, hasScheduledFooter, removeScheduledFooter } = require('../../utils/footer');

const { isSystemMessage } = require('../../config/systemMessages');

const { isSupportedMedia, mediaToContentPart, mediaTag, buildAttachmentTag } = require('../../utils/media');
const { normalizeMarkdown } = require('../../utils/text');
const { syncFileToHistory, getStoredHistoryMediaDescription, getStoredHistoryVoiceTranscription, retrieveRecentVoiceText, storeHistoryVoiceTranscription } = require('../../utils/historySync');
const { toWhatsAppMediaArgs } = require('../../utils/attachments');
const { sendAttachmentsWithFallback } = require('../../utils/attachmentFallback');
const { createLogger } = require('../../utils/logger');

const log = createLogger('WhatsAppResponse');

const _MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/tiff': '.tiff',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/webm': '.webm', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/html': '.html', 'text/csv': '.csv', 'application/json': '.json',
};

function _resolveWaFilename(givenName, mediaType, mimetype, msgId = null) {
  if (givenName && path.extname(givenName)) return givenName;
  const baseMime = (mimetype || '').split(';')[0].trim().toLowerCase();
  const ext = _MIME_TO_EXT[baseMime] || '';
  // Use unique short ID-based name instead of caption to avoid message text as filename
  const shortId = msgId ? msgId.slice(-8) : Date.now().toString(36);
  const base = givenName || `file_${shortId}`;
  return ext ? `${base}${ext}` : base;
}

function _waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

async function _getRecentWhatsAppMessageIds(msg) {
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
 * @param {object} chat - whatsapp-web.js Chat object
 * @param {string} platform - Platform identifier ('whatsapp_dedicated' | 'whatsapp_personal')
 * @returns {Promise<Array>} Array of history messages with role ('user'|'assistant') and content
 */
async function buildWhatsAppHistory(chat, platform, userId) {
  const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
  const messages = rawMessages.slice(-MAX_HISTORY);

  const historyMessages = [];

  for (const msg of messages) {
    let senderName;
    let isGemiX = false;
    let isScheduled = false;
    let isSystem = false;

    if (platform === PLATFORM_WA_PERSONAL) {
      if (msg.fromMe) {
        if (hasScheduledFooter(msg.body)) {
          senderName = '[System]';
          isScheduled = true;
        } else if (isSystemMessage(msg.body)) {
          senderName = '[System]';
          isSystem = true;
        } else if (hasFooter(msg.body)) {
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
      if (msg.fromMe) {
        if (hasScheduledFooter(msg.body)) {
          senderName = '[System]';
          isScheduled = true;
        } else if (isSystemMessage(msg.body)) {
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

    const ts = formatTimestamp(msg.timestamp * 1000);
    let textContent;
    if (isScheduled) {
      textContent = removeScheduledFooter(msg.body || '');
    } else if (isSystem) {
      textContent = msg.body || '';
    } else if (isGemiX) {
      textContent = removeFooter(msg.body || '');
    } else {
      textContent = msg.body || '';
    }

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
      const mediaType = msg.type;
      const filename = _resolveWaFilename(msg._data?.filename, msg.type, msg._data?.mimetype, msg.id.id);
      const duration = Number(msg.duration || msg._data?.duration || 0);
      const isAudioType = mediaType === 'audio' || mediaType === 'ptt';

      const fetchBuffer = async () => {
        const media = await msg.downloadMedia();
        return media ? Buffer.from(media.data, 'base64') : null;
      };
      const syncedPath = await syncFileToHistory(userId, msg.id.id, fetchBuffer, filename);
      const tag = buildAttachmentTag(syncedPath, filename);

      if (isSupportedMedia(mediaType)) {
        if (isAudioType) {
          const storedVoiceText = getStoredHistoryVoiceTranscription(userId, syncedPath);
          const cachedText = storedVoiceText || retrieveRecentVoiceText(chat.id._serialized, msg.timestamp * 1000);
          if (!storedVoiceText && cachedText) storeHistoryVoiceTranscription(userId, syncedPath, cachedText);
          const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'audio');
          if (cachedText) {
            textContent = `${textContent} ${tag} <Transcription>${cachedText}</Transcription>`.trim();
          } else if (cachedDescription) {
            textContent = `${textContent} ${tag} <Description kind="audio">${cachedDescription}</Description>`.trim();
          } else if (isGemiX) {
            textContent = `${textContent} ${tag} (transcription unavailable)`.trim();
          } else if (duration > 0 && duration > MAX_AUDIO_DURATION_S) {
            textContent = `${textContent} ${tag} (audio too long: ${duration}s, max ${MAX_AUDIO_DURATION_S}s)`.trim();
          } else {
            textContent = `${textContent} ${tag}`.trim();
          }
        } else if (mediaType === 'video') {
          const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'video');
          if (cachedDescription) {
            textContent = `${textContent} ${tag} <Description kind="video">${cachedDescription}</Description>`.trim();
          } else if (duration > 0 && duration > MAX_VIDEO_DURATION_S) {
            textContent = `${textContent} ${tag} (video too long: ${duration}s, max ${MAX_VIDEO_DURATION_S}s)`.trim();
          } else {
            textContent = `${textContent} ${tag}`.trim();
          }
        } else {
          textContent = `${textContent} ${tag}`.trim();
        }
      } else {
        textContent = `${textContent} ${tag}`.trim();
      }
    }

    if (!textContent) continue;

    const prefix = `[${ts}] ${senderName}: `;

    historyMessages.push({
      role: isFromBot ? 'assistant' : 'user',
      content: `${prefix}${textContent}`,
    });
  }

  return historyMessages;
}

/**
 * Extract quoted message content if this message is a reply.
 * Handles audio (cache transcription + duration check) and PDF (page check).
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - Chat ID for voice cache lookup
 * @returns {Promise<object>} { prefix: string, mediaParts: array }
 */
async function extractQuotedMessageContent(msg, chatId, userId, recentMessageIds) {
  if (!msg.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return { prefix: '', mediaParts: [] };

    let prefix = '';
    const mediaParts = [];

    if (quoted.hasMedia) {
      const filename = _resolveWaFilename(quoted._data?.filename, quoted.type, quoted._data?.mimetype, quoted.id.id);
      const mediaType = quoted.type;
      const isAudio = mediaType === 'audio' || mediaType === 'ptt';
      const duration = Number(quoted.duration || quoted._data?.duration || 0);

      const fetchBuffer = async () => {
        const media = await quoted.downloadMedia();
        return media ? Buffer.from(media.data, 'base64') : null;
      };
      let syncedPath = null;
      try {
        syncedPath = await syncFileToHistory(userId, quoted.id.id, fetchBuffer, filename);
      } catch (err) {
        log.warn(`Failed to sync quoted media to history: ${err.message}`);
      }
      const tag = buildAttachmentTag(syncedPath, filename);
      const quotedMessageKey = _waMessageKey(quoted);
      const isQuotedInRecentHistory = Boolean(quotedMessageKey) && recentMessageIds instanceof Set && recentMessageIds.has(quotedMessageKey);

      const isVideo = mediaType === 'video';
      if (isAudio) {
        const storedVoiceText = getStoredHistoryVoiceTranscription(userId, syncedPath);
        const cachedText = storedVoiceText || (chatId ? retrieveRecentVoiceText(chatId, quoted.timestamp * 1000) : null);
        if (!storedVoiceText && cachedText) storeHistoryVoiceTranscription(userId, syncedPath, cachedText);
        const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'audio');
        if (cachedText) {
          prefix = `[In reply to: ${tag} <Transcription>${cachedText}</Transcription>]\n`;
        } else if (cachedDescription) {
          prefix = `[In reply to: ${tag} <Description kind="audio">${cachedDescription}</Description>]\n`;
        } else if (duration > MAX_AUDIO_DURATION_S) {
          prefix = `[In reply to: ${tag} (audio too long: ${duration}s, max ${MAX_AUDIO_DURATION_S}s)]\n`;
        } else {
          prefix = `[In reply to: ${tag}]\n`;
          try {
            const buffer = await fetchBuffer();
            if (buffer) {
              mediaParts.push(mediaToContentPart(buffer, quoted._data?.mimetype, {
                historyPath: syncedPath,
                historyUserId: userId,
              }));
            }
          } catch { }
        }
        return { prefix, mediaParts };
      }

      if (isVideo) {
        const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'video');
        if (cachedDescription) {
          prefix = `[In reply to: ${tag} <Description kind="video">${cachedDescription}</Description>]\n`;
        } else if (duration > MAX_VIDEO_DURATION_S) {
          prefix = `[In reply to: ${tag} (video too long: ${duration}s, max ${MAX_VIDEO_DURATION_S}s)]\n`;
        } else {
          prefix = `[In reply to: ${tag}]\n`;
          try {
            const buffer = await fetchBuffer();
            if (buffer) mediaParts.push(mediaToContentPart(buffer, quoted._data?.mimetype, {
              historyPath: syncedPath,
              historyUserId: userId,
            }));
          } catch { }
        }
        return { prefix, mediaParts };
      }

      if (mediaType === 'document' && quoted._data?.mimetype === 'application/pdf') {
        prefix = `[In reply to: ${tag}]\n`;
        if (isQuotedInRecentHistory) {
          try {
            const buffer = await fetchBuffer();
            if (buffer) {
              mediaParts.push(mediaToContentPart(buffer, quoted._data?.mimetype, {
                historyPath: syncedPath,
                historyUserId: userId,
              }));
            }
          } catch { }
        }
        return { prefix, mediaParts };
      }

      if (mediaType === 'document') {
        prefix = `[In reply to: ${tag}]\n`;
        return { prefix, mediaParts };
      }

      prefix = `[In reply to: ${tag}]\n`;
      try {
        const buffer = await fetchBuffer();
        if (buffer) {
          mediaParts.push(mediaToContentPart(buffer, quoted._data?.mimetype, {
            historyPath: syncedPath,
            historyUserId: userId,
          }));
        }
      } catch { }
      return { prefix, mediaParts };
    }

    if (quoted.body) {
      let quotedText = quoted.body;
      if (hasFooter(quotedText)) {
        quotedText = removeFooter(quotedText);
      }
      prefix = `[In reply to: ${quotedText}]\n`;
      return { prefix, mediaParts };
    }

    return { prefix: '', mediaParts: [] };
  } catch {
    return { prefix: '', mediaParts: [] };
  }
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
 * Process current message media with duration/page checks.
 * @param {object} msg - The whatsapp-web.js message object
 * @returns {Promise<object|null>} { skipped, buffer?, mimetype?, filename?, tag, reason? } or null
 */
async function processCurrentMedia(msg, userId) {
  if (!msg.hasMedia) return null;

  const mediaType = msg.type;
  const isAudio = mediaType === 'audio' || mediaType === 'ptt';
  const isVideo = mediaType === 'video';
  const duration = Number(msg.duration || msg._data?.duration || 0);

  if (isAudio && duration > MAX_AUDIO_DURATION_S) {
    return {
      skipped: true,
      tag: mediaTag(msg._data?.filename, msg._data?.mimetype),
      reason: `audio too long: ${duration}s, max ${MAX_AUDIO_DURATION_S}s`,
    };
  }

  if (isVideo && duration > 0 && duration > MAX_VIDEO_DURATION_S) {
    return {
      skipped: true,
      tag: mediaTag(msg._data?.filename, msg._data?.mimetype),
      reason: `video too long: ${duration}s, max ${MAX_VIDEO_DURATION_S}s`,
    };
  }

  if (!isSupportedMedia(mediaType)) {
    return {
      skipped: true,
      tag: mediaTag(msg._data?.filename, msg._data?.mimetype),
      reason: null,
    };
  }

  let buffer = null;
  let mimetype = null;
  let filename = msg._data?.filename || null;

  try {
    const media = await msg.downloadMedia();
    if (media) {
      buffer = Buffer.from(media.data, 'base64');
      mimetype = media.mimetype;
      filename = _resolveWaFilename(filename, msg.type, mimetype, msg.id.id);
    }
  } catch { }

  let syncedPath = null;
  if (buffer) {
    const fetchBuffer = async () => buffer;
    try {
      syncedPath = await syncFileToHistory(userId, msg.id.id, fetchBuffer, filename);
    } catch (err) {
      log.warn(`Failed to sync current media to history: ${err.message}`);
    }
  }

  const tag = syncedPath ? buildAttachmentTag(syncedPath, filename) : mediaTag(filename, mimetype);

  if (!buffer) {
    return { skipped: true, tag, reason: 'file unavailable' };
  }

  if (mediaType === 'document' && mimetype !== 'application/pdf') {
    return {
      skipped: true,
      tag,
      reason: null,
    };
  }

  return {
    skipped: false,
    buffer,
    mimetype,
    filename,
    syncedPath,
    tag,
  };
}

/**
 * Build the contentParts array for an incoming WhatsApp message.
 * Handles vcard/poll text formatting, quoted message content, and current message media.
 * Extracted to avoid duplication between dedicated and personal handlers.
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - The chat's serialized ID (for voice cache lookup)
 * @returns {Promise<Array>} contentParts array (may be empty if message has no usable content)
 */
async function buildIncomingContentParts(msg, chatId, userId) {
  const contentParts = [];
  let textBody = msg.body || '';

  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    textBody = `[Shared contact] ${textBody}`;
  } else if (msg.type === 'poll_creation') {
    textBody = formatWhatsAppPollText(msg, `[Poll] ${textBody}`);
  }

  const recentMessageIds = await _getRecentWhatsAppMessageIds(msg);
  const quotedContent = await extractQuotedMessageContent(msg, chatId, userId, recentMessageIds);
  if (quotedContent && quotedContent.prefix) {
    textBody = quotedContent.prefix + textBody;
  }
  if (quotedContent && Array.isArray(quotedContent.mediaParts) && quotedContent.mediaParts.length > 0) {
    contentParts.push(...quotedContent.mediaParts);
  }

  const mediaResult = await processCurrentMedia(msg, userId);
  if (mediaResult) {
    if (mediaResult.skipped) {
      const suffix = mediaResult.reason ? ` (${mediaResult.reason})` : '';
      textBody = `${mediaResult.tag}${suffix} ${textBody}`.trim();
    } else {
      contentParts.push(mediaToContentPart(mediaResult.buffer, mediaResult.mimetype, {
        historyPath: mediaResult.syncedPath,
        historyUserId: userId,
      }));
      textBody = `${mediaResult.tag} ${textBody}`.trim();
    }
  } else if (msg.hasMedia) {
    const tag = mediaTag(null, msg._data?.mimetype);
    textBody = `${tag} (file unavailable) ${textBody}`.trim();
  }

  if (textBody) {
    contentParts.unshift({ type: 'text', text: textBody });
  }

  return contentParts;
}

module.exports = { buildWhatsAppHistory, buildIncomingContentParts, processCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent };
