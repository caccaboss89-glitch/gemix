const { findMemberByName } = require('../config/members');
const { removeDiscordEmoji } = require('../utils/discord');

let dedicatedClient = null;

/**
 * Store reference to WhatsApp dedicated client for message sending.
 * @param {object} client - The whatsapp-web.js Client instance
 */
function setDedicatedClient(client) {
  dedicatedClient = client;
}

/**
 * Normalize phone number to WhatsApp JID format.
 * Accepts multiple formats: +39123, 0039123, 123, etc.
 * @param {string} phone - Phone number in any standard format
 * @returns {string} Normalized WhatsApp JID (phone@c.us)
 */
function normalizePhoneToJid(phone) {
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  return cleaned + '@c.us';
}

/**
 * Send a WhatsApp message via the dedicated account.
 * @param {string} recipientName - Full name of the recipient
 * @param {string} message - Message text
 * @param {object} [options]
 * @param {boolean} [options.isAdmin] - Whether the sender is admin
 * @param {string} [options.recipientPhone] - Direct phone number (admin only, for non-members)
 * @returns {Promise<string>} Result message
 */
async function sendWhatsAppMessage(recipientName, message, options = {}) {
  if (!dedicatedClient) {
    return 'Errore: client WhatsApp dedicato non disponibile.';
  }

  message = removeDiscordEmoji(message);

  if (options.isAdmin && options.recipientPhone) {
    const jid = normalizePhoneToJid(options.recipientPhone);
    try {
      await dedicatedClient.sendMessage(jid, message);
      return `Messaggio WhatsApp inviato con successo a ${options.recipientPhone}.`;
    } catch (err) {
      return `Errore invio messaggio a ${options.recipientPhone}: ${err.message}`;
    }
  }

  const member = findMemberByName(recipientName);
  if (!member) {
    if (options.isAdmin) {
      return `Errore: "${recipientName}" non trovato tra i membri attivi. Specifica recipientPhone per inviare a non-membri.`;
    }
    return `Errore: "${recipientName}" non è un membro attivo. Non posso inviare messaggi a non-membri.`;
  }

  try {
    await dedicatedClient.sendMessage(member.wa, message);
    return `Messaggio WhatsApp inviato con successo a ${member.name}.`;
  } catch (err) {
    return `Errore invio messaggio a ${member.name}: ${err.message}`;
  }
}

/**
 * Send a WhatsApp message directly to a JID (used by scheduler).
 */
async function sendWhatsAppDirect(chatId, message, options = {}) {
  if (!dedicatedClient) throw new Error('Client WhatsApp dedicato non disponibile');
  // Only clean text messages; MessageMedia objects must be passed through untouched
  if (typeof message === 'string') {
    message = removeDiscordEmoji(message);
  }
  await dedicatedClient.sendMessage(chatId, message, options);
}

/**
 * Send attachments (images, PDFs) via WhatsApp to a recipient.
 * @param {string} recipientName - Full name of the recipient
 * @param {array} attachments - Array of attachment objects { name, buffer, mimetype }
 * @param {object} [options]
 * @param {boolean} [options.isAdmin] - Whether the sender is admin
 * @param {string} [options.recipientPhone] - Direct phone number (admin only, for non-members)
 * @param {string} [options.caption] - Optional caption for the attachments
 * @returns {Promise<string>} Result message
 */
async function sendWhatsAppAttachments(recipientName, attachments, options = {}) {
  if (!dedicatedClient) {
    return 'Errore: client WhatsApp dedicato non disponibile.';
  }

  const { MessageMedia } = require('whatsapp-web.js');

  try {
    const jid = (() => {
      if (options.isAdmin && options.recipientPhone) {
        return normalizePhoneToJid(options.recipientPhone);
      }
      const member = findMemberByName(recipientName);
      if (!member) {
        if (options.isAdmin) {
          throw new Error(`"${recipientName}" non trovato tra i membri attivi. Specifica recipientPhone per inviare a non-membri.`);
        }
        throw new Error(`"${recipientName}" non è un membro attivo. Non posso inviare messaggi a non-membri.`);
      }
      return member.wa;
    })();

    if (!Array.isArray(attachments) || attachments.length === 0) {
      throw new Error('Nessun allegato da inviare');
    }

    // Send each attachment as separate message
    for (const att of attachments) {
      if (!att.buffer || !att.mimetype) continue;
      const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
      await dedicatedClient.sendMessage(jid, media);
    }

    const recipientDisplay = options.isAdmin && options.recipientPhone ? options.recipientPhone : recipientName;
    return `${attachments.length} allegato/i inviato/i con successo a ${recipientDisplay}.`;
  } catch (err) {
    return `Errore invio allegati: ${err.message}`;
  }
}

/**
 * Send a WhatsApp voice message to a recipient.
 * @param {string} recipientName - Full name of the recipient
 * @param {string} voiceText - Text to convert to voice
 * @param {object} [options]
 * @param {boolean} [options.isAdmin] - Whether the sender is admin
 * @param {string} [options.recipientPhone] - Direct phone number (admin only, for non-members)
 * @returns {Promise<string>} Result message
 */
async function sendWhatsAppVoice(recipientName, voiceText, options = {}) {
  if (!dedicatedClient) {
    return 'Errore: client WhatsApp dedicato non disponibile.';
  }

  voiceText = removeDiscordEmoji(voiceText);
  const { generateVoice } = require('./voiceMessage');
  const { MessageMedia } = require('whatsapp-web.js');

  try {
    const voiceBuffer = await generateVoice(voiceText);
    const media = new MessageMedia('audio/ogg', voiceBuffer.toString('base64'), 'voice.ogg');

    if (options.isAdmin && options.recipientPhone) {
      const jid = normalizePhoneToJid(options.recipientPhone);
      await dedicatedClient.sendMessage(jid, media, { sendAudioAsVoice: true });
      return `Messaggio vocale inviato con successo a ${options.recipientPhone}.`;
    }

    const member = findMemberByName(recipientName);
    if (!member) {
      if (options.isAdmin) {
        return `Errore: "${recipientName}" non trovato tra i membri attivi. Specifica recipientPhone per inviare a non-membri.`;
      }
      return `Errore: "${recipientName}" non è un membro attivo. Non posso inviare messaggi a non-membri.`;
    }

    await dedicatedClient.sendMessage(member.wa, media, { sendAudioAsVoice: true });
    return `Messaggio vocale inviato con successo a ${member.name}.`;
  } catch (err) {
    return `Errore invio messaggio vocale: ${err.message}`;
  }
}

/**
 * Get the currently stored dedicated client (or null).
 * Useful for other modules to detect the dedicated account JID.
 */
function getDedicatedClient() {
  return dedicatedClient;
}

module.exports = { sendWhatsAppMessage, sendWhatsAppDirect, sendWhatsAppVoice, sendWhatsAppAttachments, setDedicatedClient, normalizePhoneToJid, getDedicatedClient };
