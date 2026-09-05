import constants from '../../config/constants.js';

function waMessageKey(msg) {
  return msg?.id?._serialized || msg?.id?.id || null;
}

async function fetchWhatsAppMessageWindow(chat) {
  const rawMessages = await chat.fetchMessages({ limit: constants.MAX_HISTORY + 5 });
  const windowMessages = rawMessages.slice(-constants.MAX_HISTORY);
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

export { fetchWhatsAppMessageWindow, getRecentWhatsAppMessageIds, waMessageKey };
