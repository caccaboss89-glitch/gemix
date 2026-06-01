// src/utils/voiceTextCache.js
//
// Thin convenience wrapper around the voice text cache functions
// living in historySync.js. Provides a stable, small API surface
// for storing and retrieving recent voice message transcriptions
// used when the user sends voice notes.

const { storeRecentVoiceText, retrieveRecentVoiceText } = require('./historySync');

/**
 * Store the transcription of a recently received voice message.
 * @param {string} chatId
 * @param {string} text
 */
function storeVoiceText(chatId, text) {
  return storeRecentVoiceText(chatId, text);
}

/**
 * Retrieve a previously stored voice transcription for a message
 * whose timestamp is close to the given one (used for context).
 * @param {string} chatId
 * @param {number} msgTimestampMs
 * @returns {string|null}
 */
function retrieveVoiceText(chatId, msgTimestampMs) {
  return retrieveRecentVoiceText(chatId, msgTimestampMs);
}

module.exports = { storeVoiceText, retrieveVoiceText };
