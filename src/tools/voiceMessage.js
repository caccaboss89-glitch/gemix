// src/tools/voiceMessage.js
//
// Voice generation pipeline. Produces OGG/Opus audio buffers for WhatsApp
// voice messages. Uses the direct xAI TTS endpoint (`POST /v1/tts`) when
// enabled (primary), with Google Translate TTS fallback. Always applies
// MP3-to-Opus transcode. Strips vocal tags for Google TTS input (speech
// tags are written by GemiX itself in the voice reply `response` text).

const googleTTS = require('google-tts-api');
const { spawn } = require('child_process');
const { fetchWithTimeout, readResponseBodyWithTimeout } = require('../utils/fetch');
const { fetchXaiWithOAuthRetry } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { createLogger } = require('../utils/logger');
const { XAI_TTS_ENABLED } = require('../config/constants');
const { FFMPEG_PATH } = require('../config/env');
const { getXaiAuth } = require('../config/xaiAuth');

const log = createLogger('TTS');

// xAI TTS request timeout (usually completes in a few seconds).
const TTS_REQUEST_TIMEOUT_MS = 90 * 1000;

// Overall voice generation timeout covering TTS and transcode. On expiry, the call fails rather than hanging.
const VOICE_GENERATION_TIMEOUT_MS = 120 * 1000;

// Fixed xAI TTS parameters: voice + auto language detection + MP3 output
// (transcoded to OGG/Opus for WhatsApp below).
const TTS_VOICE_ID = 'leo';
const TTS_OUTPUT_FORMAT = { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 };

/**
 * Strip vocal effect tags from text.
 * Removes both inline tags [xxx] and wrapping tags <xxx>...</xxx>.
 * Used when falling back to Google Translate which doesn't support vocal
 * effects. Also useful when the model's text accidentally contains tags.
 * @param {string} text - Text potentially containing vocal effect markup
 * @returns {string} Cleaned text with all effect tags removed and spaces normalized
 */
function stripVocalTags(text) {
  return text
    .replace(/\[[\w:-]+\]/g, '')       // [pause], [laugh], etc.
    .replace(/<\/?[\w-]+>/g, '')       // <soft>, </soft>, etc.
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Convert MP3 buffer to WhatsApp-compatible OGG/Opus format.
 * Transcodes to 48kHz mono, 32kbps (Opus codec), optimized for iOS WhatsApp voice message playback speed.
 * @param {Buffer} mp3Buffer - Raw MP3 audio data as Buffer
 * @returns {Promise<Buffer>} Transcoded OGG/Opus audio buffer
 */
function convertMp3ToWhatsAppOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-compression_level',
      '10',
      '-application',
      'voip',
      '-f',
      'ogg',
      'pipe:1',
    ];

    const ffmpegCmd = FFMPEG_PATH;
    const ffmpeg = spawn(ffmpegCmd, ffmpegArgs);
    const chunks = [];
    let stderr = '';

    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
    });
    ffmpeg.on('error', err => {
      reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
    });
    ffmpeg.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`FFmpeg audio conversion failed (code ${code}): ${stderr || 'unknown error'}`));
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.end(mp3Buffer);
  });
}

/**
 * Generate voice audio using the direct xAI TTS endpoint (primary) with
 * Google Translate TTS fallback.
 * Enforces a global timeout to prevent indefinite hangs on TTS or ffmpeg failures.
 * @param {string} text - Text to convert to speech (max 1000 characters).
 *   May contain xAI speech tags ([pause], <soft>...</soft>, ...) - GemiX
 *   writes them directly; they are stripped for the Google fallback.
 * @returns {Promise<Buffer>} OGG/Opus audio buffer (48kHz mono, iOS-optimized WhatsApp format)
 */
async function generateVoice(text) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Voice generation timeout (${VOICE_GENERATION_TIMEOUT_MS / 1000}s)`)),
      VOICE_GENERATION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([_generateVoice(text), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function _generateVoice(text) {
  // Try the direct xAI TTS endpoint first (only if enabled).
  if (XAI_TTS_ENABLED) {
    try {
      const mp3Buffer = await xaiTTS(text);
      return await convertMp3ToWhatsAppOpus(mp3Buffer);
    } catch (err) {
      log.warn('xAI TTS failed, falling back to Google Translate:', err.message);
      await notifyAdmin('xAI TTS (Fallback)', err.message);
    }
  }

  // Google Translate TTS fallback. Strip vocal tags defensively before use,
  // as the text may contain vocal tags.
  const cleanText = stripVocalTags(text);

  try {
    return await googleTranslateTTS(cleanText);
  } catch (err) {
    if (!XAI_TTS_ENABLED) {
      // Notify admin on Google TTS failure when xAI TTS is disabled.
      await notifyAdmin('Google TTS (Primary)', err.message);
      throw new Error(`TTS failed: Google Translate service error. xAI TTS is currently DISABLED by Admin.${ADMIN_NOTIFIED_SUFFIX}`);
    }
    throw err;
  }
}

// -- xAI TTS (direct endpoint) ----------------------------------------------

/**
 * Call `POST /v1/tts` and return the MP3 buffer. Uses shared xAI OAuth refresh
 * (disk reload + Hermes when XAI_USE_API_KEY=false).
 */
async function xaiTTS(text) {
  const { baseUrl } = getXaiAuth();
  const res = await fetchXaiWithOAuthRetry(`${baseUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice_id: TTS_VOICE_ID,
      language: 'auto',
      output_format: TTS_OUTPUT_FORMAT,
    }),
  }, { timeoutMs: TTS_REQUEST_TIMEOUT_MS, maxAttempts: 2 });

  const buffer = Buffer.from(await readResponseBodyWithTimeout(res.arrayBuffer(), TTS_REQUEST_TIMEOUT_MS));
  if (buffer.length === 0) {
    throw new Error('xAI TTS returned an empty audio body.');
  }
  return buffer;
}

// -- Google Translate TTS (fallback) --------------------------------------

/**
 * Google Translate TTS fallback (fixed language: Italian, fixed speed: normal).
 */
async function googleTranslateTTS(text) {
  const urls = googleTTS.getAllAudioUrls(text, {
    lang: 'it',
    slow: false,
    host: 'https://translate.google.com',
  });

  const buffers = await Promise.all(
    urls.map(async ({ url }) => {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`TTS download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );

  const mp3Buffer = Buffer.concat(buffers);
  return convertMp3ToWhatsAppOpus(mp3Buffer);
}

module.exports = { generateVoice, stripVocalTags };
