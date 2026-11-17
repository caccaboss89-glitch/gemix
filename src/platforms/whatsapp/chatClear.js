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

/* global window -- _clearAndCountInPage runs in the browser page */

/**
 * Runs inside the WhatsApp Web page, so it must stay self-contained: clears
 * the chat first when asked, then looks for messages older than `before` that
 * the history window could still read, stopping at the first batch with any.
 * @param {string} chatId
 * @param {number} before - unix seconds
 * @param {number} windowLimit - how many messages the history window reads
 * @param {boolean} clearFirst
 * @returns {Promise<{ found: boolean, left: number }>} left = 0 when none is readable
 */
async function _clearAndCountInPage(chatId, before, windowLimit, clearFirst) {
  const found = await window.WWebJS.getChat(chatId, { getAsModel: false });
  if (!found) return { found: false, left: 0 };
  const chat = window.require('WAWebStateUtils').unproxy(found);
  if (clearFirst) {
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
    // Runs even after a failed request: besides removing the cleared messages
    // it releases the pending clear, which would otherwise answer every later
    // clear of this chat with the same failure. It rethrows that failure,
    // except a server status error, which the re-read below catches instead.
    await finalizeClearChat(chat, pending, unreadCount);
  }

  // Read the chat the way whatsapp-web.js's fetchMessages fills the history
  // window: the loaded messages first, then earlier ones from storage.
  // Notifications do not count: they carry no text the history could show, and
  // WhatsApp keeps the end-to-end encryption notice through every clear.
  const { getIsNotification } = window.require('WAWebMsgGetters');
  const readable = (msgs) => msgs.filter(msg => !getIsNotification(msg));
  const countEarlier = (msgs) => msgs.filter(msg => msg.t < before).length;
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
  const { found, left } = await page.evaluate(_clearAndCountInPage, chatId, wipedAt, WINDOW_FETCH_LIMIT, true);
  if (!found) {
    log.warn(`Chat clear skipped for ${chatId}: WhatsApp Web does not know the chat`);
    return false;
  }
  if (left > 0) {
    log.warn(`Chat clear left messages older than the clear in ${chatId}`);
    return false;
  }
  return true;
}

/**
 * True when the history window could read anything from the chat, so there is
 * something to clear. Reads only.
 * @param {object} page - Puppeteer page running WhatsApp Web
 * @param {string} chatId
 * @returns {Promise<boolean>}
 */
async function chatHasHistoryInPage(page, chatId) {
  const { left } = await page.evaluate(
    _clearAndCountInPage, chatId, Number.MAX_SAFE_INTEGER, WINDOW_FETCH_LIMIT, false
  );
  return left > 0;
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

export { chatHasHistoryInPage, clearChatInPage, clearWhatsAppChat };
