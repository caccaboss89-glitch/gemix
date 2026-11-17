import constants from '../../config/constants.js';
import { forgetWipeCutoff, getWipeCutoff } from '../../utils/wipeCutoffs.js';

/** How many of the newest messages WhatsApp is asked for, before any cutoff. */
const WINDOW_FETCH_LIMIT = constants.MAX_HISTORY + 5;

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

/**
 * The messages a turn may read: the newest ones, minus everything older than
 * the chat's last wipe (see utils/wipeCutoffs.js).
 */
async function fetchWhatsAppMessageWindow(chat) {
  const chatId = chat.id._serialized;
  const rawMessages = await chat.fetchMessages({ limit: WINDOW_FETCH_LIMIT });
  const wipedAt = getWipeCutoff(chatId);
  let messages = rawMessages;
  if (wipedAt !== null) {
    messages = rawMessages.filter(msg => Number(msg.timestamp) >= wipedAt);
    if (rawMessages.length >= WINDOW_FETCH_LIMIT && messages.length === rawMessages.length) {
      await forgetWipeCutoff(chatId);
    }
  }
  const windowMessages = messages.slice(-constants.MAX_HISTORY);
  return {
    windowMessages,
    recentMessageIds: new Set(windowMessages.map(waMessageKey).filter(Boolean))
  };
}

async function getRecentWhatsAppMessageIds(msg) {
  try {
    const chat = await msg.getChat();
    return (await fetchWhatsAppMessageWindow(chat)).recentMessageIds;
  } catch {
    return new Set();
  }
}

export {
  WINDOW_FETCH_LIMIT,
  fetchWhatsAppMessageWindow,
  getRecentWhatsAppMessageIds,
  waMessageKey
};
