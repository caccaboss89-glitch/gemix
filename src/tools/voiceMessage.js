// src/tools/voiceMessage.js
const googleTTS = require('google-tts-api');
const { spawn } = require('child_process');
const { XAI_API_KEY, XAI_TTS_VOICE } = require('../config/env');
const { XAI_TTS_URL, XAI_TTS_ENABLED } = require('../config/constants');
const { fetchWithTimeout } = require('../utils/fetch');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { createLogger } = require('../utils/logger');

const log = createLogger('TTS');

/**
 * Strip vocal effect tags from text.
 * Removes both inline tags [xxx] and wrapping tags <xxx>...</xxx>.
 * Used when falling back to Google Translate which doesn't support vocal effects.
 * @param {string} text - Text potentially containing vocal effect markup
 * @returns {string} Cleaned text with all effect tags removed and spaces normalized
 */
function stripVocalTags(text) {
  return text
    .replace(/\[[\w:-]+\]/g, '')       // [pause], [laugh], [image:1], etc.
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

    const ffmpegCmd = process.env.FFMPEG_PATH || 'ffmpeg';
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

const VOICE_GENERATION_TIMEOUT_MS = 30_000;

/**
 * Generate voice audio using xAI TTS (primary) with Google Translate TTS fallback.
 * Supports vocal effect tags for dynamic voice modulation (xAI only, not Google Translate).
 * Enforces a global timeout to prevent indefinite hangs on TTS or ffmpeg failures.
 * @param {string} text - Text to convert to speech (max 1000 characters)
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
  // Try xAI TTS first (only if enabled)
  if (XAI_TTS_ENABLED && XAI_API_KEY) {
    try {
      const mp3Buffer = await xaiTTS(text);
      return convertMp3ToWhatsAppOpus(mp3Buffer);
    } catch (err) {
      log.warn('xAI TTS failed, falling back to Google Translate:', err.message);
      await notifyAdmin('xAI TTS (Fallback)', err.message);
    }
  }

  // Use Google Translate TTS
  // Strip vocal tags (Google doesn't support them, and if XAI is disabled we MUST strip them)
  const cleanText = stripVocalTags(text);
  
  try {
    return await googleTranslateTTS(cleanText);
  } catch (err) {
    if (!XAI_TTS_ENABLED) {
      // Notify admin automatically so the AI's "already reported" claim is true
      await notifyAdmin('Google TTS (Primary)', err.message);
      
      // Hard failure when XAI is disabled: explain to the AI why it failed and not to retry or report.
      throw new Error(`TTS failed: Google Translate service error. xAI TTS is currently DISABLED by Admin.${ADMIN_NOTIFIED_SUFFIX}`);
    }
    // If it was a fallback failure during XAI_TTS_ENABLED=true, just rethrow normally
    throw err;
  }
}

/**
 * xAI TTS — voice "eve", language "auto", output mp3 44100Hz 128kbps.
 */
async function xaiTTS(text) {
  const res = await fetchWithTimeout(XAI_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice_id: XAI_TTS_VOICE || 'eve',
      language: 'it',
      output_format: { codec: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`xAI TTS ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

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
