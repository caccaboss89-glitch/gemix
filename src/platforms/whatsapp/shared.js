const { MessageMedia } = require('whatsapp-web.js');
const { MAX_HISTORY } = require('../../config/constants');
const { formatTimestamp } = require('../../utils/time');
const { hasFooter, removeFooter, hasScheduledFooter, removeScheduledFooter } = require('../../utils/footer');
const { isSupportedMedia, isUnsupportedMedia, mediaToContentPart, mediaTag } = require('../../utils/media');

/**
 * Fetch last N messages from a WhatsApp chat and build history array.
 * @param {object} chat - whatsapp-web.js Chat object
 * @param {string} platform - 'whatsapp_dedicated' | 'whatsapp_personal'
 * @param {string|null} botJid - The bot's own JID (for identifying GemiX messages)
 * @returns {{ historyMessages: Array, currentMediaParts: Array }}
 */
async function buildWhatsAppHistory(chat, platform, botJid) {
  const rawMessages = await chat.fetchMessages({ limit: MAX_HISTORY + 5 });
  const messages = rawMessages.slice(-MAX_HISTORY);

  const historyMessages = [];

  for (const msg of messages) {
    let senderName;
    let isGemiX = false;
    let isScheduled = false;

    if (platform === 'whatsapp_personal') {
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
      // Dedicated account
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

    // Handle special message types
    if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
      textContent = `[Contatto condiviso] ${textContent || ''}`;
    } else if (msg.type === 'poll_creation') {
      try {
        textContent = `[Sondaggio] ${msg.body || ''}`;
      } catch {
        textContent = '[Sondaggio]';
      }
    }

    // Handle media — download supported types for multimodal history
    if (msg.hasMedia) {
      const mediaType = msg.type;
      const filename = msg._data?.filename || msg._data?.caption || null;
      const tag = mediaTag(filename, msg._data?.mimetype);

      if (isSupportedMedia(mediaType)) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const buffer = Buffer.from(media.data, 'base64');
            mediaParts.push(mediaToContentPart(buffer, media.mimetype));
          }
        } catch {}
        textContent = `${textContent} ${tag}`.trim();
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

  return historyMessages;
}

/**
 * Download media from current message if supported.
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
 * Returns string to prepend to current message content.
 * - If reply is to text: returns the quoted text with [In reply to: ...]
 * - If reply is to media: returns [nomefile.estensione]
 */
async function extractQuotedMessageContent(msg) {
  if (!msg.hasQuotedMsg) return '';

  try {
    const quoted = await msg.getQuotedMessage();
    if (!quoted) return '';

    // If quoted message has media (and is a supported type), return just the filename
    if (quoted.hasMedia) {
      const mediaType = quoted.type;
      const filename = quoted._data?.filename || quoted._data?.caption || null;
      const tag = mediaTag(filename, quoted._data?.mimetype);
      return `[In reply to: ${tag}]\n`;
    }

    // If quoted message is text, return the text
    if (quoted.body) {
      let quotedText = quoted.body;
      // Remove GemiX footer if present
      if (hasFooter(quotedText)) {
        quotedText = removeFooter(quotedText);
      }
      return `[In reply to: ${quotedText}]\n`;
    }

    return '';
  } catch {
    return '';
  }
}

/**
 * Send response back to WhatsApp chat.
 */
async function sendWhatsAppResponse(chat, msg, responseData) {
  // Voice message
  if (responseData.isVoiceOnly && responseData.voiceBuffer) {
    const media = new MessageMedia('audio/ogg', responseData.voiceBuffer.toString('base64'), 'voice.ogg');
    await chat.sendMessage(media, { sendAudioAsVoice: true });
    return;
  }

  // Text message
  if (responseData.text) {
    await chat.sendMessage(responseData.text);
  }

  // File attachments
  if (responseData.attachments && responseData.attachments.length > 0) {
    for (const att of responseData.attachments) {
      const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
      await chat.sendMessage(media);
    }
  }
}

module.exports = { buildWhatsAppHistory, downloadCurrentMedia, sendWhatsAppResponse, extractQuotedMessageContent };
