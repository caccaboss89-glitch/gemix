const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY, PLATFORM_WA_PERSONAL } = require('../../config/constants');
const { formatWhatsAppPollText } = require('../../utils/pollParser');
const { formatTimestamp } = require('../../utils/time');
const { hasFooter, removeFooter, hasScheduledFooter, removeScheduledFooter } = require('../../utils/footer');
const { isSupportedMedia, isUnsupportedMedia, mediaToContentPart, mediaTag, limitHistoryMediaAttachments } = require('../../utils/media');

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

      if (isSupportedMedia(mediaType)) {
        if ((mediaType === 'audio' || mediaType === 'ptt') && duration > 60) {
          textContent = `${textContent} ${tag} (troppo lungo per essere letto: ${duration}s)`.trim();
        } else {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              const buffer = Buffer.from(media.data, 'base64');
              mediaParts.push(mediaToContentPart(buffer, media.mimetype));
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

return limitHistoryMediaAttachments(historyMessages, Number.MAX_SAFE_INTEGER, 3);
}

/**
 * Download media from current message if supported.
 * @param {object} msg - The whatsapp-web.js message object
 * @returns {Promise<object|null>} Media object { buffer, mimetype, filename } or null if not available/unsupported
 */
async function downloadCurrentMedia(msg) {
  if (!msg.hasMedia) return null;
  if (!isSupportedMedia(msg.type)) return null;

  try {
    const media = await msg.downloadMedia();
    if (!media) return null;
    return {
      buffer: Buffer.from(media.data, 'base64'),
      mimetype: media.mimetype,
      filename: media.filename || null,
    };
  } catch {
    return null;
  }
}

/**
 * Extract quoted message content if this message is a reply.
 * Returns string to prepend to current message content with context.
 * - If reply is to text: returns quoted text with [In reply to: ...] prefix
 * - If reply is to media: returns filename/tag with [In reply to: ...] prefix
 * @param {object} msg - The whatsapp-web.js message object
 * @returns {Promise<string>} Formatted quoted message context or empty string if not a reply
 */
async function extractQuotedMessageContent(msg) {
  if (!msg.hasQuotedMsg) return { prefix: '', mediaParts: [] };

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return { prefix: '', mediaParts: [] };

    let prefix = '';
    const mediaParts = [];

    if (quoted.hasMedia) {
      // For quoted media, include tag text and actual media if it's from GemiX (or user wants it implicitly).
      const filename = quoted._data?.filename || quoted._data?.caption || null;
      const tag = mediaTag(filename, quoted._data?.mimetype);
      prefix = `[In reply to: ${tag}]\n`;

      if (quoted.fromMe) {
        try {
          const media = await quoted.downloadMedia();
          if (media) {
            const buffer = Buffer.from(media.data, 'base64');
            mediaParts.push(mediaToContentPart(buffer, media.mimetype));
          }
        } catch {}
      }

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

module.exports = { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent };
