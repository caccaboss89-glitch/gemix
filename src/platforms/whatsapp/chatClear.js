// src/platforms/whatsapp/chatClear.js
//
// Empties a WhatsApp chat on the bot's own account and checks that it really
// happened. Used by the wipe command and by scripts/clear-whatsapp-chats.js.
//
// whatsapp-web.js's chat.clearMessages() cannot be used: it calls WhatsApp Web's
// WAWebChatClearBridge.sendClear(chat, false), which does not match that
// function's (chat, lastMsgKey, keepStarred) signature, and it skips the step
// that removes the messages from the page, so it resolves true and clears
// nothing. This module makes the calls WhatsApp Web's own "Clear chat" makes
// (WAWebSendClearChatAction), without its undo toast and delay.
//
// The other side of the chat keeps its copy either way: clearing a chat only
// ever affects the account that does it.

import { createLogger } from '../../utils/logger.js';
import { WINDOW_FETCH_LIMIT } from './messageWindow.js';

const log = createLogger('WhatsAppChatClear');

/* global window -- _clearChatInPage runs in the browser page */

/**
 * Runs inside the WhatsApp Web page, so it must stay self-contained.
 * @param {string} chatId
 * @param {number} wipedAt - unix seconds; older messages must be gone
 * @param {number} windowLimit - how many messages the history window reads
 * @returns {Promise<{ found: boolean, left: number }>} left = older messages still readable
 */
async function _clearChatInPage(chatId, wipedAt, windowLimit) {
  const found = await window.WWebJS.getChat(chatId, { getAsModel: false });
  if (!found) return { found: false, left: 0 };
  const chat = window.require('WAWebStateUtils').unproxy(found);
  const { initClearChat, finalizeClearChat } = window.require('WAWebClearChatUtils');
  const unreadCount = chat.unreadCount;
  // false: starred messages go too.
  const pending = initClearChat(chat, false);
  await pending.then(() => {
    // Tells WhatsApp Web the phone holds nothing older, so it does not load
    // the cleared messages back on demand.
    chat.endOfHistoryTransferType = window.require('WAWebChatConstants')
      .ConversationEndOfHistoryTransferModelPropType.COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY;
  }, () => {});
  // Runs even after a failed request: besides removing the cleared messages it
  // releases the pending clear, which would otherwise answer every later clear
  // of this chat with the same failure. It rethrows that failure, except a
  // server status error, which the re-read below catches instead.
  await finalizeClearChat(chat, pending, unreadCount);

  // Re-read the chat the way whatsapp-web.js's fetchMessages fills the history
  // window: the loaded messages first, then earlier ones from storage.
  const readable = (msgs) => msgs.filter(msg => !msg.isNotification);
  const countEarlier = (msgs) => msgs.filter(msg => msg.t < wipedAt).length;
  let seen = readable(chat.msgs.getModelsArray());
  let left = countEarlier(seen);
  let read = seen.length;
  while (left === 0 && read < windowLimit) {
    const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
    if (!earlier || earlier.length === 0) break;
    seen = readable(earlier);
    left += countEarlier(seen);
    read += seen.length;
  }
  return { found: true, left };
}

/**
 * Clear one chat through a WhatsApp Web page: done only if no message older
 * than `wipedAt` is left where the history window would read it.
 *
 * @param {object} page - Puppeteer page running WhatsApp Web
 * @param {string} chatId - whatsapp-web.js chat id (_serialized)
 * @param {number} wipedAt - unix seconds the clear started at
 * @returns {Promise<boolean>}
 */
async function clearChatInPage(page, chatId, wipedAt) {
  const { found, left } = await page.evaluate(_clearChatInPage, chatId, wipedAt, WINDOW_FETCH_LIMIT);
  if (!found) {
    log.warn(`Chat clear skipped for ${chatId}: WhatsApp Web does not know the chat`);
    return false;
  }
  if (left > 0) {
    log.warn(`Chat clear left ${left} earlier message(s) in ${chatId}`);
    return false;
  }
  return true;
}

/**
 * Clear a chat of a running whatsapp-web.js client.
 * @param {object} chat - whatsapp-web.js Chat
 * @param {number} wipedAt - unix seconds the clear started at
 * @returns {Promise<boolean>}
 */
async function clearWhatsAppChat(chat, wipedAt) {
  return clearChatInPage(chat.client.pupPage, chat.id._serialized, wipedAt);
}

export { clearChatInPage, clearWhatsAppChat };
