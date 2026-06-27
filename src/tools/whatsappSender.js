// src/tools/whatsappSender.js
//
// Thin wrapper around the dedicated WhatsApp client for direct sending.
// Used by scheduler and recipient tools. Applies WhatsApp text sanitization
// before delivery (normalizeMarkdown, stripOutgoingDeliveryArtifacts) and
// strips the mention tags GemiX must never send (Meta AI everywhere; its own
// @gemix), so direct sends (send_whatsapp_message, scheduled reminders) follow
// the same mention rules as current-chat replies.

const { normalizeMarkdown, stripOutgoingDeliveryArtifacts } = require('../utils/text');
const { stripDisallowedOutgoingMentions, normalizeOutgoingMentionTags, collectMentionJids } = require('../utils/waMentions');

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
  // Only clean text messages; MessageMedia objects must be passed through untouched.
  // Direct sends never go to the current chat, so @gemix self-tags and Meta AI
  // tags are always disallowed here (matches current-chat reply stripping).
  const sendOptions = { ...options };
  if (typeof message === 'string') {
    message = normalizeOutgoingMentionTags(message);
    // In a group target, turn the @<number> tags GemiX kept into real WhatsApp
    // mentions (matches sendWhatsAppResponse); strip the disallowed ones first.
    if (typeof chatId === 'string' && chatId.endsWith('@g.us') && !Array.isArray(sendOptions.mentions)) {
      const mentions = collectMentionJids(message);
      if (mentions.length > 0) sendOptions.mentions = mentions;
    }
    message = stripDisallowedOutgoingMentions(message, { isPersonal: true });
    message = normalizeMarkdown(stripOutgoingDeliveryArtifacts(message));
  }

  await dedicatedClient.sendMessage(chatId, message, sendOptions);
}

module.exports = { sendWhatsAppDirect, setDedicatedClient, normalizePhoneToJid, isValidPhoneNumber };
