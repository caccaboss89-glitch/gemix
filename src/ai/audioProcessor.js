// src/ai/audioProcessor.js
//
// Pre-processing step: replaces every audio content part in the messages array
// with a <Transcription> text part, using Hermes /v1/audio/transcriptions.
//
// This is necessary because /v1/chat/completions via Hermes does not reliably
// support input_audio content parts for Grok 4.3.
//
// Audio parts are stored as { type: 'image_url', image_url: { url: 'data:audio/...;base64,...' } }
// (the legacy carrier format used by mediaToContentPart for audio).

const { transcribeAudio } = require('./audioTranscriber');
const { createLogger } = require('../utils/logger');
const { getStoredHistoryVoiceTranscription, storeHistoryVoiceTranscription } = require('../utils/historySync');
const { getMediaDurationSec } = require('../utils/mediaDuration');
const { MAX_AUDIO_DURATION_S } = require('../config/constants');

const log = createLogger('AudioProcessor');

/**
 * Walk an OpenAI-format messages array, locate every audio content part
 * (type: 'image_url' with audio/* MIME, or type: 'input_audio') and replace
 * it in-place with a text part containing `<Transcription>…</Transcription>`.
 *
 * Parts are mutated once so they are not re-processed on subsequent rounds.
 *
 * @param {Array} messages
 * @returns {Promise<Array>} Same array (mutated in-place)
 */
async function processAudioInMessages(messages) {
  if (!Array.isArray(messages)) return messages;

  const targets = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const part = msg.content[pi];
      if (!part) continue;

      // New format: input_audio (produced by mediaToContentPart for audio)
      if (part.type === 'input_audio' && part.audio?.data) {
        targets.push({ mi, pi, part, format: 'input_audio' });
        continue;
      }

      // Legacy format: image_url with audio/* MIME data URI
      if (part.type === 'image_url' && part.image_url?.url) {
        const m = /^data:([^;]+);base64,/.exec(part.image_url.url);
        if (m && m[1].toLowerCase().startsWith('audio/')) {
          targets.push({ mi, pi, part, format: 'image_url', mime: m[1], b64: part.image_url.url.split(',')[1] });
        }
      }
    }
  }

  if (targets.length === 0) return messages;

  log.info(`🎤 Processing ${targets.length} audio part(s)…`);

  for (const target of targets) {
    const { mi, pi, part } = target;

    // Check history cache first
    const historyPath = typeof part._historyPath === 'string' ? part._historyPath : null;
    const userId = typeof part._historyUserId === 'string' ? part._historyUserId : null;
    const cached = historyPath && userId
      ? getStoredHistoryVoiceTranscription(userId, historyPath)
      : null;

    if (cached) {
      log.info(`   ♻️ Reused cached transcription for ${historyPath}`);
      messages[mi].content[pi] = {
        type: 'text',
        text: `<Transcription>\n${cached}\n</Transcription>`,
      };
      continue;
    }

    // Extract buffer from the part
    let buffer = null;
    let mimetype = 'audio/ogg';

    if (target.format === 'input_audio') {
      try {
        buffer = Buffer.from(part.audio.data, 'base64');
        mimetype = `audio/${part.audio.format || 'ogg'}`;
      } catch { buffer = null; }
    } else {
      // image_url format
      try {
        buffer = Buffer.from(target.b64, 'base64');
        mimetype = target.mime;
      } catch { buffer = null; }
    }

    if (!buffer || buffer.length === 0) {
      log.warn(`   ⚠️ Audio part at msg[${mi}][${pi}] has empty buffer — skipping`);
      messages[mi].content[pi] = {
        type: 'text',
        text: '<Transcription>transcription unavailable (empty audio buffer)</Transcription>',
      };
      continue;
    }

    // Check duration cap before transcribing
    const extHint = mimetype.split('/')[1]?.split(';')[0] || 'ogg';
    const durationSec = await getMediaDurationSec(buffer, extHint);
    if (durationSec !== null && durationSec > MAX_AUDIO_DURATION_S) {
      log.warn(`   ⚠️ Audio too long (${durationSec.toFixed(1)}s > ${MAX_AUDIO_DURATION_S}s) — skipping transcription`);
      messages[mi].content[pi] = {
        type: 'text',
        text: `<Transcription>transcription unavailable (audio too long: ${Math.round(durationSec)}s, limit is ${MAX_AUDIO_DURATION_S}s)</Transcription>`,
      };
      continue;
    }

    const text = await transcribeAudio(buffer, mimetype);

    if (text) {
      messages[mi].content[pi] = {
        type: 'text',
        text: `<Transcription>\n${text}\n</Transcription>`,
      };
      // Cache for future rounds
      if (historyPath && userId) {
        const stored = storeHistoryVoiceTranscription(userId, historyPath, text);
        if (stored) log.info(`   💾 Stored transcription for ${historyPath}`);
      }
    } else {
      log.warn(`   ⚠️ Transcription failed for msg[${mi}][${pi}] — using fallback text`);
      messages[mi].content[pi] = {
        type: 'text',
        text: '<Transcription>transcription unavailable (service error)</Transcription>',
      };
    }
  }

  const ok = targets.filter((_, i) => {
    const t = targets[i];
    return messages[t.mi].content[t.pi]?.type === 'text' &&
      messages[t.mi].content[t.pi]?.text?.includes('<Transcription>');
  }).length;
  log.info(`   ✅ ${ok}/${targets.length} audio part(s) transcribed`);

  return messages;
}

module.exports = { processAudioInMessages };
