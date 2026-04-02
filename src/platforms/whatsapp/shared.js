const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL, MAX_AUDIO_DURATION_S, MAX_DOC_PAGES } = require('../../config/constants');
const pdfParse = require('pdf-parse');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { formatTimestamp } = require('../../utils/time');
const { hasFooter, removeFooter, hasScheduledFooter, removeScheduledFooter } = require('../../utils/footer');
const { isSupportedMedia, isUnsupportedMedia, mediaToContentPart, mediaTag, limitHistoryMediaAttachments } = require('../../utils/media');
const { retrieveVoiceText } = require('../../utils/voiceTextCache');

/**
 * Fetch last N messages from a WhatsApp chat and build history array.
 * Includes message context, media handling, and footer cleanup for GemiX messages.
 * @param {object} chat - whatsapp-web.js Chat object
 * @param {string} platform - Platform identifier ('whatsapp_dedicated' | 'whatsapp_personal')
 * @param {string|null} botJid - The bot's own JID for identifying GemiX messages to skip footers
 * @returns {Promise<Array>} Array of history messages with role ('user'|'assistant') and content
 */
async function buildWhatsAppHistory(chat, platform, botJid) {
  const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
  const messages = rawMessages.slice(-MAX_HISTORY);

  const historyMessages = [];

  for (const msg of messages) {
    let senderName;
    let isGemiX = false;
    let isScheduled = false;

    if (platform === PLATFORM_WA_PERSONAL) {
      if (msg.fromMe) {
        if (hasScheduledFooter(msg.body)) {
          senderName = '[System]';
          isScheduled = true;
        } else if (hasFooter(msg.body)) {
          senderName = 'GemiX';
          isGemiX = true;
        } else {
          senderName = 'Tu (proprietario account)';
        }
      } else {
        try {
          const contact = await msg.getContact();
          senderName = contact.pushname || contact.name || msg.from;
        } catch {
          senderName = msg.from || 'Sconosciuto';
        }
      }
    } else {
      if (msg.fromMe) {
        if (hasScheduledFooter(msg.body)) {
          senderName = '[System]';
          isScheduled = true;
        } else {
          senderName = 'GemiX';
          isGemiX = true;
        }
      } else {
        try {
          const contact = await msg.getContact();
          senderName = contact.pushname || contact.name || msg.from;
        } catch {
          senderName = msg.from || 'Sconosciuto';
        }
      }
    }

    const ts = formatTimestamp(msg.timestamp * 1000);
    let textContent;
    if (isScheduled) {
      textContent = removeScheduledFooter(msg.body || '');
    } else if (isGemiX) {
      textContent = removeFooter(msg.body || '');
    } else {
      textContent = msg.body || '';
    }
    const mediaParts = [];

    if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
      textContent = `[Contatto condiviso] ${textContent || ''}`;
    } else if (msg.type === 'poll_creation') {
      try {
        textContent = formatWhatsAppPollText(msg, `[Sondaggio] ${msg.body || ''}`);
      } catch {
        textContent = '[Sondaggio]';
      }
    }

    if (msg.hasMedia) {
      const mediaType = msg.type;
      const filename = msg._data?.filename || msg._data?.caption || null;
      const tag = mediaTag(filename, msg._data?.mimetype);
      const duration = Number(msg.duration || msg._data?.duration || 0);
      const isAudioType = mediaType === 'audio' || mediaType === 'ptt';

      if (isSupportedMedia(mediaType)) {
        if (isAudioType) {
          // GemiX audio → transcription (check cache first, then isGemiX flag)
          const cachedText = retrieveVoiceText(chat.id._serialized, msg.timestamp * 1000);
          if (cachedText) {
            textContent = `${textContent} ${tag} TRASCRIZIONE: ${cachedText}`.trim();
          } else if (isGemiX) {
            textContent = `${textContent} ${tag} (trascrizione non disponibile)`.trim();
          } else if (duration > MAX_AUDIO_DURATION_S) {
            textContent = `${textContent} ${tag} (troppo lungo per essere letto: ${duration}s)`.trim();
          } else {
            try {
              const media = await msg.downloadMedia();
              if (media) {
                mediaParts.push(mediaToContentPart(Buffer.from(media.data, 'base64'), media.mimetype));
              }
            } catch {}
            textContent = `${textContent} ${tag}`.trim();
          }
        } else if (mediaType === 'document' && msg._data?.mimetype === 'application/pdf') {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              const buffer = Buffer.from(media.data, 'base64');
              const info = await pdfParse(buffer);
              if (info.numpages > MAX_DOC_PAGES) {
                textContent = `${textContent} ${tag} (troppo lungo per essere letto: ${info.numpages} pagine)`.trim();
              } else {
                mediaParts.push(mediaToContentPart(buffer, media.mimetype));
                textContent = `${textContent} ${tag}`.trim();
              }
            }
          } catch {
            textContent = `${textContent} ${tag}`.trim();
          }
        } else {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              mediaParts.push(mediaToContentPart(Buffer.from(media.data, 'base64'), media.mimetype));
            }
          } catch {}
          textContent = `${textContent} ${tag}`.trim();
        }
      } else if (isUnsupportedMedia(mediaType)) {
        textContent = `${textContent} ${tag} (file non visionabile)`.trim();
      } else {
        textContent = `${textContent} ${tag}`.trim();
      }
    }

    if (!textContent && mediaParts.length === 0) continue;

    const prefix = `[${ts}] ${senderName}: `;

    if (mediaParts.length > 0) {
      historyMessages.push({
        role: isGemiX ? 'assistant' : 'user',
        content: [
          { type: 'text', text: `${prefix}${textContent}` },
          ...mediaParts,
        ],
      });
    } else if (textContent) {
      historyMessages.push({
        role: isGemiX ? 'assistant' : 'user',
        content: `${prefix}${textContent}`,
      });
    }
  }

return limitHistoryMediaAttachments(historyMessages, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
}

/**
 * Extract quoted message content if this message is a reply.
 * Handles audio (cache transcription + duration check) and PDF (page check).
 * @param {object} msg - The whatsapp-web.js message object
 * @param {string} chatId - Chat ID for voice cache lookup
 * @returns {Promise<object>} { prefix: string, mediaParts: array }
 */
async function extractQuotedMessageContent(msg, chatId) {
  if (!msg.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return { prefix: '', mediaParts: [] };

    let prefix = '';
    const mediaParts = [];

    if (quoted.hasMedia) {
      const filename = quoted._data?.filename || quoted._data?.caption || null;
      const tag = mediaTag(filename, quoted._data?.mimetype);
      const mediaType = quoted.type;
      const isAudio = mediaType === 'audio' || mediaType === 'ptt';
      const duration = Number(quoted.duration || quoted._data?.duration || 0);

      if (isAudio) {
        const cachedText = chatId ? retrieveVoiceText(chatId, quoted.timestamp * 1000) : null;
        if (cachedText) {
          prefix = `[In reply to: ${tag} TRASCRIZIONE: ${cachedText}]\n`;
        } else if (duration > MAX_AUDIO_DURATION_S) {
          prefix = `[In reply to: ${tag} (audio troppo lungo: ${duration}s)]\n`;
        } else {
          prefix = `[In reply to: ${tag}]\n`;
          try {
            const media = await quoted.downloadMedia();
            if (media) {
              mediaParts.push(mediaToContentPart(Buffer.from(media.data, 'base64'), media.mimetype));
            }
          } catch {}
        }
        return { prefix, mediaParts };
      }

      if (mediaType === 'document' && quoted._data?.mimetype === 'application/pdf') {
        try {
          const media = await quoted.downloadMedia();
          if (media) {
            const buffer = Buffer.from(media.data, 'base64');
            const info = await pdfParse(buffer);
            if (info.numpages > MAX_DOC_PAGES) {
              prefix = `[In reply to: ${tag} (troppo lungo: ${info.numpages} pagine)]\n`;
            } else {
              prefix = `[In reply to: ${tag}]\n`;
              mediaParts.push(mediaToContentPart(buffer, media.mimetype));
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
        const media = await quoted.downloadMedia();
        if (media) {
          mediaParts.push(mediaToContentPart(Buffer.from(media.data, 'base64'), media.mimetype));
        }
      } catch {}
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
 * @param {object} msg - The original whatsapp-web.js message object
 * @param {object} responseData - Response data { text, voiceBuffer, isVoiceOnly, attachments }
 * @returns {Promise<void>}
 */
async function sendWhatsAppResponse(chat, msg, responseData) {
  if (responseData.isVoiceOnly && responseData.voiceBuffer) {
    const media = new MessageMedia('audio/ogg', responseData.voiceBuffer.toString('base64'), 'voice.ogg');
    await chat.sendMessage(media, { sendAudioAsVoice: true });
    // Continue to send attachments below (don't return early)
  }

  if (responseData.text) {
    await chat.sendMessage(responseData.text);
  }

  if (responseData.attachments && responseData.attachments.length > 0) {
    for (const att of responseData.attachments) {
      const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
      await chat.sendMessage(media);
    }
  }
}

/**
 * Process current message media with duration/page checks.
 * @param {object} msg - The whatsapp-web.js message object
 * @returns {Promise<object|null>} { skipped, buffer?, mimetype?, filename?, tag, reason? } or null
 */
async function processCurrentMedia(msg) {
  if (!msg.hasMedia) return null;

  const mediaType = msg.type;
  const isAudio = mediaType === 'audio' || mediaType === 'ptt';
  const duration = Number(msg.duration || msg._data?.duration || 0);

  if (isAudio && duration > MAX_AUDIO_DURATION_S) {
    return {
      skipped: true,
      tag: mediaTag(msg._data?.filename, msg._data?.mimetype),
      reason: `audio troppo lungo: ${duration}s, non inviato`,
    };
  }

  if (!isSupportedMedia(mediaType)) {
    return {
      skipped: true,
      tag: mediaTag(msg._data?.filename, msg._data?.mimetype),
      reason: isUnsupportedMedia(mediaType) ? 'file non visionabile' : null,
    };
  }

  try {
    const media = await msg.downloadMedia();
    if (!media) return null;

    const buffer = Buffer.from(media.data, 'base64');

    if (media.mimetype === 'application/pdf') {
      try {
        const info = await pdfParse(buffer);
        if (info.numpages > MAX_DOC_PAGES) {
          return {
            skipped: true,
            tag: mediaTag(media.filename, media.mimetype),
            reason: `documento troppo lungo: ${info.numpages} pagine, non inviato`,
          };
        }
      } catch {}
    }

    return {
      skipped: false,
      buffer,
      mimetype: media.mimetype,
      filename: media.filename || null,
      tag: mediaTag(media.filename, media.mimetype),
    };
  } catch {
    return null;
  }
}

module.exports = { buildWhatsAppHistory, processCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent };
