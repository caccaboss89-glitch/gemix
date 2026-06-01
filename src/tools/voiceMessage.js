// src/tools/voiceMessage.js
//
// Voice generation pipeline.
//
// Why we shell out to `hermes -t tts -z` instead of hitting an HTTP endpoint:
//
// Hermes Agent v0.14's OpenAI-compatible proxy does NOT forward `/v1/tts`.
// Hitting it returns:
//   404 {"error":{"message":"Path /v1/tts is not forwarded by this proxy.
//        Allowed: /chat/completions, /completions, /embeddings, /models,
//        /responses","type":"path_not_allowed","code":"path_not_allowed"}}
//
// Same pattern as Imagine (image/video gen): the only way to reach the
// xAI text_to_speech tool is through the Hermes CLI. We restrict the
// toolset to `tts` (-t tts) so the model has exactly one tool available
// and cannot wander off - the upstream caller hands plain text and the
// CLI itself decides where to insert vocal tags. This concentration on a
// single task tends to produce better-sounding audio.
//
// Architecture:
//   1. Caller passes raw text (no vocal tags from GemiX-Main).
//   2. We pick a deterministic temp output path under .tempfiles/.
//   3. We invoke `bridge/tts.sh "<text>" "<path>"`. The bridge prompts
//      Hermes to use only `text_to_speech`, speak the exact text (any
//      language, no rewrites), and save to the path we provided.
//   4. On success we read the MP3 from disk and transcode to Opus/OGG.
//   5. The text (stripped of any vocal tags that Hermes may have added)
//      is stored via storeRecentVoiceText() for history injection without
//      tags (so the history shows what the user heard, not the internal
//      markup).
//   6. On any failure (proxy unreachable, file not produced, transcode
//      error) we fall back to Google Translate TTS, which strips any
//      vocal tags first since it can't render them.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const googleTTS = require('google-tts-api');
const { spawn } = require('child_process');
const { fetchWithTimeout } = require('../utils/fetch');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { createLogger } = require('../utils/logger');
const { getPublicAttachmentUrl } = require('../utils/tempFileServer');
const { XAI_TTS_ENABLED } = require('../config/constants');
const { FFMPEG_PATH } = require('../config/env');

const log = createLogger('TTS');

// Absolute path to the wrapper. Spawned via `bash` so the executable bit
// is irrelevant (matches bridge/imagine.sh contract).
const BRIDGE_SCRIPT = path.resolve(__dirname, '..', '..', 'bridge', 'tts.sh');

// Absolute path to temp directory for audio output. Matches tempFileServer.js
// so all temp files live in the same place.
const TEMP_DIR = path.resolve(__dirname, '..', '..', '.tempfiles');

// hermes -t tts -z usually completes in 5-30 s. Keep the ceiling generous
// to absorb cold starts on the VPS without leaving zombies hanging forever.
const TTS_BRIDGE_TIMEOUT_MS = 90 * 1000;

// Outer-loop timeout covers both bridge call and ffmpeg transcode. If we
// blow past this we give up and let the dispatcher report a hard failure
// to the AI - better than indefinitely hanging the round.
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

  // Google Translate TTS fallback. It can't render vocal tags, so strip
  // them defensively (text from upstream is plain, but the bridge may
  // also have failed AFTER Hermes started writing tagged text - strip
  // anyway).
  const cleanText = stripVocalTags(text);

  try {
    return await googleTranslateTTS(cleanText);
  } catch (err) {
    if (!XAI_TTS_ENABLED) {
      // Notify admin automatically so the AI's "already reported" claim is true.
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
    // Best-effort cleanup: the bridge may have created the parent dir but
    // not the file. Don't leave dangling parent dirs around if empty.
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
