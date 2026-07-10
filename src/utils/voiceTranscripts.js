// src/utils/voiceTranscripts.js
//
// GemiX voice messages appear in chat history as plain [Attachment] tags
// (assistant-side entries cannot carry native file parts). To keep their
// spoken content visible to the model, stored transcriptions (history_meta)
// are injected on the CURRENT user turn as <PastVoiceReply> blocks — past
// context only, not new user uploads or reply instructions.

const path = require('path');
const { extractAttachmentTagPaths } = require('./media');
const { getStoredHistoryVoiceTranscription } = require('./historySync');
const { escapeXml } = require('./xmlEscape');

const VOICE_AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a']);

function _formatPastVoiceReply(name, text) {
  const safeName = escapeXml(name);
  const safeText = escapeXml(text);
  return `<PastVoiceReply file="${safeName}">${safeText}</PastVoiceReply>`;
}

/**
 * Scan assistant history for GemiX voice [Attachment] tags with a stored
 * transcription and return a single text content part with <PastVoiceReply>
 * blocks. Caller should gate on voice-reply capability (WA dedicated only).
 *
 * @param {Array} history - chat-completion history messages.
 * @param {string|null} storageId - history storage id for this conversation.
 * @returns {object[]} one `{ type: 'text', text }` part, or empty when none.
 */
function buildPastVoiceReplyBlocks(history, storageId) {
  if (!storageId || !Array.isArray(history) || history.length === 0) return [];

  const blocks = [];
  const seen = new Set();
  for (const msg of history) {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    for (const tagPath of extractAttachmentTagPaths(msg.content)) {
      const name = path.basename(tagPath.trim());
      if (!name || seen.has(name)) continue;
      if (!VOICE_AUDIO_EXTS.has(path.extname(name).toLowerCase())) continue;
      seen.add(name);
      const text = getStoredHistoryVoiceTranscription(storageId, name);
      if (text) blocks.push(_formatPastVoiceReply(name, text));
    }
  }
  if (blocks.length === 0) return [];

  return [{ type: 'text', text: blocks.join('\n') }];
}

module.exports = {
  buildPastVoiceReplyBlocks,
};
