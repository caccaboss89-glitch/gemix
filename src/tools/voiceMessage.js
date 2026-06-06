// src/tools/voiceMessage.js
//
// Voice generation pipeline. Produces OGG/Opus audio buffers for WhatsApp
// voice messages. Uses xAI TTS via Hermes bridge when enabled (primary),
// with Google Translate TTS fallback. Always applies MP3-to-Opus transcode.
// Strips vocal tags for Google TTS input.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const googleTTS = require('google-tts-api');
const { spawn } = require('child_process');
const { fetchWithTimeout } = require('../utils/fetch');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { createLogger } = require('../utils/logger');
const { XAI_TTS_ENABLED } = require('../config/constants');
const { FFMPEG_PATH } = require('../config/env');

const log = createLogger('TTS');

// Absolute path to the wrapper script. Spawned via `bash` (executable bit not required).
const BRIDGE_SCRIPT = path.resolve(__dirname, '..', '..', 'bridge', 'tts.sh');

// Absolute path to temp directory for audio output (shared location with tempFileServer.js).
const TEMP_DIR = path.resolve(__dirname, '..', '..', '.tempfiles');

// TTS bridge call timeout. Hermes -t tts usually completes in 5-30 s; ceiling set high to handle cold starts.
const TTS_BRIDGE_TIMEOUT_MS = 90 * 1000;

// Overall voice generation timeout covering bridge and transcode. On expiry, the call fails rather than hanging.
const VOICE_GENERATION_TIMEOUT_MS = 120 * 1000;

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
 * Generate voice audio using xAI TTS via the Hermes CLI bridge (primary)
 * with Google Translate TTS fallback.
 * Enforces a global timeout to prevent indefinite hangs on TTS or ffmpeg failures.
 * @param {string} text - Plain text to convert to speech (max 1000 characters,
 *   no vocal tags from the caller - the bridge tells Hermes to insert them).
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
  // Try xAI TTS via the Hermes CLI bridge first (only if enabled).
  if (XAI_TTS_ENABLED) {
    try {
      const mp3Buffer = await xaiTTSViaBridge(text);
      return await convertMp3ToWhatsAppOpus(mp3Buffer);
    } catch (err) {
      log.warn('xAI TTS bridge failed, falling back to Google Translate:', err.message);
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

// -- xAI TTS via Hermes CLI bridge ----------------------------------------

/**
 * Spawn `bash bridge/tts.sh <text> <output_path>` and collect its result.
 * Returns the MP3 buffer read from the output path on success.
 *
 * Mirrors imagineGenerator.js's _runBridge: spawn with no shell (only
 * `bash` as the script interpreter), positional args so prompts cannot be
 * misinterpreted as shell metacharacters.
 */
async function xaiTTSViaBridge(text) {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  const outputPath = path.join(
    TEMP_DIR,
    `tts_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.mp3`,
  );

  const { code, stdout, stderr } = await _runBridge(
    [text, outputPath],
    TTS_BRIDGE_TIMEOUT_MS,
  );

  if (code !== 0) {
    const tail = (stderr || stdout || '').slice(-500).trim();
    // Best-effort cleanup of output file (bridge may create the parent dir).
    _safeUnlink(outputPath);
    throw new Error(`Bridge exit ${code}: ${tail || 'no diagnostic output'}`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Bridge succeeded but no audio file at ${outputPath}`);
  }

  let buffer;
  try {
    buffer = fs.readFileSync(outputPath);
  } finally {
    _safeUnlink(outputPath);
  }

  if (!buffer || buffer.length === 0) {
    throw new Error('TTS bridge produced an empty audio file.');
  }
  return buffer;
}

function _runBridge(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [BRIDGE_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`TTS bridge spawn failed: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`TTS bridge timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function _safeUnlink(filePath) {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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
