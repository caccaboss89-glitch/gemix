// src/tools/whatsappSender.js
//
// Thin wrapper around the dedicated WhatsApp client for direct sending.
// Used by scheduler and recipient tools. Applies WhatsApp text sanitization
// before delivery (normalizeMarkdown, stripOutgoingDeliveryArtifacts).

const { normalizeMarkdown, stripOutgoingDeliveryArtifacts } = require('../utils/text');

let dedicatedClient = null;

/**
 * Store reference to WhatsApp dedicated client for message sending.
 * @param {object} client - The whatsapp-web.js Client instance
 */
function setDedicatedClient(client) {
  dedicatedClient = client;
}

/**
 * Basic E.164-style digit check (no extra libraries). Country code required (no leading 0).
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhoneNumber(phone) {
  if (typeof phone !== 'string' || !phone.trim()) return false;
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  return /^[1-9]\d{7,14}$/.test(cleaned);
}

/**
 * Normalize phone number to WhatsApp JID format.
 * Accepts multiple formats: +39123, 0039123, 123, etc.
 * @param {string} phone - Phone number in any standard format
 * @returns {string} Normalized WhatsApp JID (phone@c.us)
 */
function normalizePhoneToJid(phone) {
  if (!isValidPhoneNumber(phone)) {
    throw new Error('Invalid phone number: use country code and 8–15 digits (e.g. +393331234567).');
  }
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  return cleaned + '@c.us';
}

/**
 * Send a WhatsApp message directly to a JID (used by scheduler).
 */
async function sendWhatsAppDirect(chatId, message, options = {}) {
  if (!dedicatedClient) throw new Error('Dedicated WhatsApp client not available');
  // Only clean text messages; MessageMedia objects must be passed through untouched
  if (typeof message === 'string') {
    message = normalizeMarkdown(stripOutgoingDeliveryArtifacts(message));
  }

  await dedicatedClient.sendMessage(chatId, message, options);
}

module.exports = { sendWhatsAppDirect, setDedicatedClient, normalizePhoneToJid, isValidPhoneNumber };
