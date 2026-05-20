// src/ai/audioTranscriber.js
//
// Transcribes audio buffers via xAI STT, fronted by the Hermes proxy.
// Used as a pre-processing step before the main Grok call.

const { HERMES_API_KEY, HERMES_BASE_URL } = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('AudioTranscriber');

const STT_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/stt`;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

// Map MIME type → file extension supported by xAI STT.
const MIME_TO_EXT = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
};

/**
 * Transcribe an audio buffer via the Hermes proxy → xAI /v1/stt.
 * Response is always JSON: { text, language, duration, words, ... }
 *
 * @param {Buffer} buffer - Raw audio bytes
 * @param {string} mimetype - MIME type (e.g. 'audio/ogg; codecs=opus')
 * @returns {Promise<string|null>} Transcription text, or null on failure
 */
async function transcribeAudio(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  if (!HERMES_API_KEY) {
    log.warn('   ⚠️ HERMES_API_KEY not configured — cannot transcribe audio');
    return null;
  }

  const cleanMime = mimetype.split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[cleanMime] || 'ogg';
  const filename = `audio.${ext}`;

  try {
    const blob = new Blob([buffer], { type: cleanMime });
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('language', 'auto');  // auto-detect language
    form.append('format', 'true');    // Inverse Text Normalization (numbers, dates, currencies)

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(STT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HERMES_API_KEY}`,
          // Do NOT set Content-Type — fetch sets it with boundary automatically
        },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn(`   ⚠️ STT HTTP ${res.status}: ${errText.substring(0, 200)}`);
      return null;
    }

    const result = await res.json();
    const text = result?.text?.trim();

    if (!text) {
      log.warn('   ⚠️ Transcription returned empty text');
      return null;
    }

    log.info(`   ✅ Transcribed ${buffer.length} bytes → ${text.length} chars`);
    return text;

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    log.warn(`   ⚠️ Transcription failed (${isTimeout ? 'timeout' : err.message})`);
    return null;
  }
}

module.exports = { transcribeAudio };
