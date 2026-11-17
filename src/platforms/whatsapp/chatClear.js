// src/platforms/whatsapp/chatClear.js
//
// Empties a WhatsApp chat on the bot's own account for the wipe command, and
// checks that it really happened.
//
// whatsapp-web.js's chat.clearMessages() cannot be used: it calls WhatsApp Web's
// WAWebChatClearBridge.sendClear(chat, false), which does not match that
// function's (chat, lastMsgKey, keepStarred) signature, and it skips the step
// that removes the messages from the page, so it resolves true and clears
// nothing. This module makes the calls WhatsApp Web's own "Clear chat" makes
// (WAWebSendClearChatAction), without its undo toast and delay.
//
// The person's own phone keeps its copy either way: clearing a chat only ever
// affects the account that does it.

import { createLogger } from '../../utils/logger.js';
import { fetchRecentWhatsAppMessages } from './messageWindow.js';

const log = createLogger('WhatsAppChatClear');

/* global window -- _clearChatInPage runs in the browser page */

/**
 * Runs inside the WhatsApp Web page, so it must stay self-contained.
 * @param {string} chatId
 * @returns {Promise<boolean>} false when the page does not know the chat
 */
async function _clearChatInPage(chatId) {
  const found = await window.WWebJS.getChat(chatId, { getAsModel: false });
  if (!found) return false;
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
  // server status error, which clearWhatsAppChat's re-read catches instead.
  await finalizeClearChat(chat, pending, unreadCount);
  return true;
}

/**
 * Clear the chat, then re-read it the way the history window does: the clear
 * counts as done only if no message older than `wipedAt` is left.
 *
 * @param {object} chat - whatsapp-web.js Chat
 * @param {number} wipedAt - unix seconds the wipe started at
 * @returns {Promise<boolean>}
 */
async function clearWhatsAppChat(chat, wipedAt) {
  const chatId = chat.id._serialized;
  const found = await chat.client.pupPage.evaluate(_clearChatInPage, chatId);
  if (!found) {
    log.warn(`Chat clear skipped for ${chatId}: WhatsApp Web does not know the chat`);
    return false;
  }
  const left = (await fetchRecentWhatsAppMessages(chat))
    .filter(msg => Number(msg.timestamp) < wipedAt).length;
  if (left > 0) {
    log.warn(`Chat clear left ${left} earlier message(s) in ${chatId}`);
    return false;
  }
  return true;
}

export { clearWhatsAppChat };
