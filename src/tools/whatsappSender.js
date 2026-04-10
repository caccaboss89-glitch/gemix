const { removeDiscordEmoji } = require('../utils/discord');
const { normalizeMarkdown } = require('../utils/text');

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
 * Send a WhatsApp message directly to a JID (used by scheduler).
 */
async function sendWhatsAppDirect(chatId, message, options = {}) {
  if (!dedicatedClient) throw new Error('Client WhatsApp dedicato non disponibile');
  // Only clean text messages; MessageMedia objects must be passed through untouched
  if (typeof message === 'string') {
    message = normalizeMarkdown(removeDiscordEmoji(message));
  }

  await dedicatedClient.sendMessage(chatId, message, options);
}

module.exports = { sendWhatsAppDirect, setDedicatedClient, normalizePhoneToJid };
