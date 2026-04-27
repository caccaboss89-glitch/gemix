// src/utils/voiceTextCache.js
const { storeRecentVoiceText, retrieveRecentVoiceText } = require('./historySync');

function storeVoiceText(chatId, text) {
  return storeRecentVoiceText(chatId, text);
}

function retrieveVoiceText(chatId, msgTimestampMs) {
  return retrieveRecentVoiceText(chatId, msgTimestampMs);
}

module.exports = { storeVoiceText, retrieveVoiceText };
