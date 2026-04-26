// src/platforms/whatsapp/shared.js
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL, MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S, MAX_DOC_PAGES } = require('../../config/constants');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { formatTimestamp } = require('../../utils/time');
const { hasFooter, removeFooter, hasScheduledFooter, removeScheduledFooter } = require('../../utils/footer');

/**
 * Detect if a WhatsApp message body is a system-generated notification.
 * Used to label messages as [System] in history without requiring a physical prefix.
 * @param {string} body
 * @returns {boolean}
 */
function _isSystemMessage(body) {
  if (!body) return false;
  return (
    /^\uD83D\uDE80 \*Nuova release GemiX:/.test(body) ||
    /^\uD83C\uDFB5 \*Wrap di /.test(body) ||
    /^\u26A0\uFE0F \*ERRORE API \u2014/.test(body) ||
    /^\uD83C\uDF19 GemiX è temporaneamente in manutenzione/.test(body)
  );
}
const { isSupportedMedia, mediaToContentPart, mediaTag, extractTextFromPdfBuffer, buildAttachmentTag } = require('../../utils/media');
const { retrieveVoiceText } = require('../../utils/voiceTextCache');
const { normalizeMarkdown } = require('../../utils/text');
const { syncFileToHistory, getStoredHistoryMediaDescription } = require('../../utils/historySync');
const { toWhatsAppMediaArgs } = require('../../utils/attachments');

const _MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/webm': '.webm',
  'video/mp4': '.mp4', 'video/webm': '.webm',
  'application/pdf': '.pdf', 'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

function _resolveWaFilename(givenName, mediaType, mimetype) {
  if (givenName && path.extname(givenName)) return givenName;
  const baseMime = (mimetype || '').split(';')[0].trim().toLowerCase();
  const ext = _MIME_TO_EXT[baseMime] || '';
  const base = givenName || mediaType || 'file';
  return ext ? `${base}${ext}` : base;
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
        } else if (_isSystemMessage(msg.body)) {
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
        } else if (_isSystemMessage(msg.body)) {
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
      const filename = _resolveWaFilename(msg._data?.filename || msg._data?.caption, msg.type, msg._data?.mimetype);
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
          const cachedText = retrieveVoiceText(chat.id._serialized, msg.timestamp * 1000);
          const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'audio');
          if (cachedText) {
            textContent = `${textContent} ${tag} <Transcription>${cachedText}</Transcription>`.trim();
          } else if (cachedDescription) {
            textContent = `${textContent} ${tag} <Description kind="audio">${cachedDescription}</Description>`.trim();
          } else if (isGemiX) {
            textContent = `${textContent} ${tag} (transcription unavailable)`.trim();
          } else if (duration > MAX_AUDIO_DURATION_S) {
            textContent = `${textContent} ${tag} (audio too long: ${duration}s, max ${MAX_AUDIO_DURATION_S}s)`.trim();
          } else {
            textContent = `${textContent} ${tag}`.trim();
          }
        } else if (mediaType === 'video') {
          const cachedDescription = getStoredHistoryMediaDescription(userId, syncedPath, 'video');
          if (cachedDescription) {
            textContent = `${textContent} ${tag} <Description kind="video">${cachedDescription}</Description>`.trim();
          } else if (duration > MAX_VIDEO_DURATION_S) {
            textContent = `${textContent} ${tag} (video too long: ${duration}s, max ${MAX_VIDEO_DURATION_S}s)`.trim();
          } else {
            textContent = `${textContent} ${tag}`.trim();
          }
        } else if (mediaType === 'document' && msg._data?.mimetype === 'application/pdf') {
          try {
            const buffer = await fetchBuffer();
            if (buffer) {
              const info = await extractTextFromPdfBuffer(buffer);
              if (!info.success) {
                textContent = `${textContent} ${tag}`.trim();
              } else if (info.pages > MAX_DOC_PAGES) {
                textContent = `${textContent} ${tag} (document too long: ${info.pages} pages)`.trim();
              } else {
                textContent = `${textContent} ${tag}`.trim();
              }
            } else {
              textContent = `${textContent} ${tag}`.trim();
            }
          } catch {
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
async function extractQuotedMessageContent(msg, chatId, userId) {
  if (!msg.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return { prefix: '', mediaParts: [] };

    let prefix = '';
    const mediaParts = [];

    if (quoted.hasMedia) {
      const filename = _resolveWaFilename(quoted._data?.filename || quoted._data?.caption, quoted.type, quoted._data?.mimetype);
      const mediaType = quoted.type;
      const isAudio = mediaType === 'audio' || mediaType === 'ptt';
      const duration = Number(quoted.duration || quoted._data?.duration || 0);

      const fetchBuffer = async () => {
        const media = await quoted.downloadMedia();
        return media ? Buffer.from(media.data, 'base64') : null;
      };
      const syncedPath = await syncFileToHistory(userId, quoted.id.id, fetchBuffer, filename);
      const tag = buildAttachmentTag(syncedPath, filename);

      const isVideo = mediaType === 'video';
      if (isAudio) {
        const cachedText = chatId ? retrieveVoiceText(chatId, quoted.timestamp * 1000) : null;
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
        try {
          const buffer = await fetchBuffer();
          if (buffer) {
            const info = await extractTextFromPdfBuffer(buffer);
            if (!info.success) {
              prefix = `[In reply to: ${tag}]\n`;
            } else if (info.pages > MAX_DOC_PAGES) {
              prefix = `[In reply to: ${tag} (document too long: ${info.pages} pages)]\n`;
            } else {
              const docText = info.text ? ` <Transcription>\n${info.text}\n</Transcription>` : '';
              prefix = `[In reply to: ${tag}${docText}]\n`;
            }
          } else {
            prefix = `[In reply to: ${tag}]\n`;
          }
        } catch {
          prefix = `[In reply to: ${tag}]\n`;
        }
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
    await chat.sendMessage(cleanedText);
  }

  if (hasAttachments) {
    for (const att of responseData.attachments) {
      const m = toWhatsAppMediaArgs(att);
      if (!m) continue;
      const media = new MessageMedia(m.mimetype, m.base64, m.name);
      await chat.sendMessage(media);
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
      filename = _resolveWaFilename(filename, msg.type, mimetype);
    }
  } catch { }

  let syncedPath = null;
  if (buffer) {
    const fetchBuffer = async () => buffer;
    syncedPath = await syncFileToHistory(userId, msg.id.id, fetchBuffer, filename);
  }

  const tag = syncedPath ? buildAttachmentTag(syncedPath, filename) : mediaTag(filename, mimetype);

  if (!buffer) {
    return { skipped: true, tag, reason: 'file unavailable' };
  }

  try {
    if (mimetype === 'application/pdf') {
      try {
        const info = await extractTextFromPdfBuffer(buffer);
        if (!info.success) {
          return {
            skipped: false,
            transcription: null,
            mimetype,
            filename,
            tag,
          };
        }
        if (info.pages > MAX_DOC_PAGES) {
          return {
            skipped: true,
            tag,
            reason: `document too long: ${info.pages} pages`,
          };
        }
        return {
          skipped: false,
          transcription: info.text ? info.text : null,
          mimetype,
          filename,
          tag,
        };
      } catch { }
    }

    return {
      skipped: false,
      buffer,
      mimetype,
      filename,
      syncedPath,
      tag,
    };
  } catch {
    return null;
  }
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

  const quotedContent = await extractQuotedMessageContent(msg, chatId, userId);
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
    } else if (mediaResult.transcription !== undefined) {
      const docText = mediaResult.transcription ? `\n<Transcription>\n${mediaResult.transcription}\n</Transcription>` : '';
      textBody = `${mediaResult.tag}${docText} ${textBody}`.trim();
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
