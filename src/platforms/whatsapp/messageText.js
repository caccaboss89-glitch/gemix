// src/platforms/whatsapp/messageText.js
//
// How a WhatsApp message turns into the text GemiX puts in front of the model.
//
// Both builders in shared.js need the same three answers — which item of an
// album carries the caption, what a non-prose message says, and which phone
// numbers are in the group — and they have to answer them identically: the
// history window and the current turn describe the same chat, so a divergence
// between them would show up as the same message reading two different ways.

import { formatWhatsAppPollText } from '../../utils/pollParser.js';
import { formatSpecialMessageText, formatWhatsAppContactText } from '../../utils/waSpecialMessages.js';

/**
 * The item of a logical WhatsApp turn that carries its text.
 *
 * A multi-attach album arrives as several protocol messages and WhatsApp puts
 * the shared caption on one of them, usually the first with a body. With no
 * body anywhere the first item stands in, so there is always a message to read
 * the type and the reply chain from.
 *
 * @param {object[]} messages - one logical turn, oldest first
 * @returns {object}
 */
function pickCaptionMessage(messages) {
  return messages.find(m => (m.body || '').trim()) || messages[0];
}

/**
 * The text of a message that is not plain prose: a special WhatsApp event, a
 * shared contact, or a poll.
 *
 * @param {object} msg
 * @param {string} [fallbackText] - the cleaned body, for the shapes that embed it
 * @returns {string|null} null when the message is ordinary prose
 */
function specialMessageText(msg, fallbackText = '') {
  const special = formatSpecialMessageText(msg);
  if (special !== null) return special;
  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    return formatWhatsAppContactText(msg.body || fallbackText || '');
  }
  if (msg.type === 'poll_creation') {
    try { return formatWhatsAppPollText(msg, `[Poll] ${fallbackText || ''}`); }
    catch { return '[Poll]'; }
  }
  return null;
}

/**
 * Phone numbers of a group's current participants.
 *
 * First level of LID tag resolution: a long @<digits> tag already matching one
 * of these is a real phone tag and needs no lookup.
 *
 * @param {object} chat - whatsapp-web.js Chat
 * @returns {Set<string>}
 */
function participantPhoneDigits(chat) {
  const digits = new Set();
  if (!Array.isArray(chat?.participants)) return digits;
  for (const p of chat.participants) {
    if (p?.id?.server !== 'c.us' || !p.id.user) continue;
    const d = String(p.id.user).replace(/\D/g, '');
    if (d) digits.add(d);
  }
  return digits;
}

export { participantPhoneDigits, pickCaptionMessage, specialMessageText };
