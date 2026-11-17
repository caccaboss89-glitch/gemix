import constants from '../../config/constants.js';
import { forgetWipeCutoff, getWipeCutoff } from '../../utils/wipeCutoffs.js';

const WINDOW_FETCH_LIMIT = constants.MAX_HISTORY + 5;

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

/** The newest messages WhatsApp holds for the chat, before any wipe cutoff applies. */
async function fetchRecentWhatsAppMessages(chat) {
  return chat.fetchMessages({ limit: WINDOW_FETCH_LIMIT });
}

/**
 * The messages a turn may read: the newest ones, minus everything older than
 * the chat's last wipe (see utils/wipeCutoffs.js).
 */
async function fetchWhatsAppMessageWindow(chat) {
  const chatId = chat.id._serialized;
  const rawMessages = await fetchRecentWhatsAppMessages(chat);
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
  fetchRecentWhatsAppMessages,
  fetchWhatsAppMessageWindow,
  getRecentWhatsAppMessageIds,
  waMessageKey
};
