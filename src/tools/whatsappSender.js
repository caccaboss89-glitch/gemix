const { findMemberByName } = require('../config/members');

// whatsappDedicated client reference - set at runtime
let dedicatedClient = null;

function setDedicatedClient(client) {
  dedicatedClient = client;
}

/**
 * Normalize a phone number to WhatsApp JID format.
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

  // Admin with direct phone number → send without member lookup
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
async function sendWhatsAppDirect(chatId, message) {
  if (!dedicatedClient) throw new Error('Client WhatsApp dedicato non disponibile');
  await dedicatedClient.sendMessage(chatId, message);
}

module.exports = { sendWhatsAppMessage, sendWhatsAppDirect, setDedicatedClient, normalizePhoneToJid };
