// src/utils/voiceTranscripts.js
//
// GemiX voice messages appear in chat history as plain [Attachment] tags
// (assistant-side entries cannot carry native file parts). To keep their
// content visible to the model, each stored transcription is materialized
// as "<voice-file>.transcript.txt" and attached to the CURRENT user turn as
// an input_file part on every call. The transcript text comes from
// history_meta (persisted when the voice message was generated - see
// historySync.js).

const fs = require('fs');
const path = require('path');
const { extractAttachmentTagPaths } = require('./media');
const { getStoredHistoryVoiceTranscription } = require('./historySync');
const { tempDirForOwner } = require('./tempFileServer');
const { uploadFileForXai } = require('./xaiUpload');
const { createLogger } = require('./logger');

const log = createLogger('VoiceTranscripts');

const VOICE_AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a']);

function _transcriptFileFor(storageId, voiceName, text) {
  const dir = path.join(tempDirForOwner(storageId), 'voice_transcripts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safe = voiceName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, `${safe}.transcript.txt`);
  // Only rewrite when the content changed, so the upload cache (keyed on
  // mtime) keeps returning the same public URL across turns.
  let current = null;
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch { /* missing */ }
  if (current !== text) fs.writeFileSync(filePath, text, 'utf-8');
  return filePath;
}

/**
 * Scan assistant history messages for GemiX voice attachments with a stored
 * transcription and return input_file parts for their transcript files.
 *
 * @param {Array} history - chat-completion history messages.
 * @param {string|null} storageId - history storage id for this conversation.
 * @returns {Promise<object[]>} input_file parts (possibly empty).
 */
async function collectGemixVoiceTranscriptParts(history, storageId) {
  if (!storageId || !Array.isArray(history) || history.length === 0) return [];

  const parts = [];
  const seen = new Set();

  for (const msg of history) {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    for (const tagPath of extractAttachmentTagPaths(msg.content)) {
      const name = path.basename(tagPath.trim());
      if (!name || seen.has(name)) continue;
      if (!VOICE_AUDIO_EXTS.has(path.extname(name).toLowerCase())) continue;
      seen.add(name);

      const text = getStoredHistoryVoiceTranscription(storageId, name);
      if (!text) continue;

      try {
        const filePath = _transcriptFileFor(storageId, name, text);
        const url = await uploadFileForXai(filePath, `${name}.transcript.txt`, 'text/plain');
        parts.push({ type: 'input_file', file_url: url });
      } catch (err) {
        log.warn(`transcript attach failed for ${name}: ${err.message}`);
      }
    }
  }

  return parts;
}

module.exports = { collectGemixVoiceTranscriptParts };
