// src/tools/voiceMessage.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
// (This file returns binary audio Buffers, so it produces no tool-facing text.)
//
// Voice generation pipeline. Produces OGG/Opus audio buffers for WhatsApp
// voice messages, always through an MP3-to-Opus transcode.
//
// TTS is a GemiX-owned feature and identical on every provider profile:
// Cartesia Sonic is the primary backend and Microsoft Edge Neural the fallback
// behind it. Both speak the same two voices (male / female), so rotating a
// spent Cartesia key or dropping to the fallback never changes the voice the
// chat asked for.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runOwnedWorker } from '../utils/ownedWorker.js';
import { spawn  } from 'child_process';
import { fetchWithTimeout, readResponseBodyWithTimeout  } from '../utils/fetch.js';
import { buildAdminNotificationNote, notifyAdminDetailed } from '../utils/adminNotifier.js';
import { createLogger  } from '../utils/logger.js';
import { defaultSettings  } from '../utils/settingsStore.js';
import envConfig from '../config/env.js';
import { cartesiaLanguage, cartesiaVoiceId, edgeVoice } from '../media/ttsVoices.js';
import { markExhausted, markWorking, nextUsableKey } from '../media/cartesiaKeyRing.js';
import { signalWithTimeout } from '../utils/turnBudget.js';


const log = createLogger('TTS');

// Single TTS request timeout (both backends usually answer in a few seconds).
const TTS_REQUEST_TIMEOUT_MS = 90 * 1000;

// Overall voice generation timeout covering TTS and transcode. On expiry, the call fails rather than hanging.
const VOICE_GENERATION_TIMEOUT_MS = 120 * 1000;

// Fixed MP3 output both backends produce (transcoded to OGG/Opus for WhatsApp below).
const CARTESIA_SAMPLE_RATE = 44100;
const CARTESIA_BIT_RATE = 128000;
const EDGE_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

/**
 * Convert MP3 buffer to WhatsApp-compatible OGG/Opus format.
 * Transcodes to 48kHz mono, 32kbps (Opus codec), optimized for iOS WhatsApp voice message playback speed.
 * @param {Buffer} mp3Buffer - Raw MP3 audio data as Buffer
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Buffer>} Transcoded OGG/Opus audio buffer
 */
function convertMp3ToWhatsAppOpus(mp3Buffer, opts = {}) {
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('FFmpeg aborted'));
      return;
    }

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
      'pipe:1'
    ];

    const ffmpegCmd = envConfig.FFMPEG_PATH;
    const ffmpeg = spawn(ffmpegCmd, ffmpegArgs);
    const chunks = [];
    let stderr = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      settle(reject, new Error('FFmpeg aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
    });
    ffmpeg.on('error', err => {
      settle(reject, new Error(`FFmpeg not found or failed to start: ${err.message}`));
    });
    ffmpeg.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        return settle(reject, new Error(`FFmpeg audio conversion failed (code ${code}): ${stderr || 'unknown error'}`));
      }
      settle(resolve, Buffer.concat(chunks));
    });

    ffmpeg.stdin.end(mp3Buffer);
  });
}

/**
 * Generate voice audio through Cartesia (primary) with the Microsoft Edge
 * fallback behind it. Enforces a global timeout and the caller's absolute turn
 * deadline.
 * @param {string} text - Text to convert to speech (max constants.MAX_TTS_CHARS characters).
 * @param {object} [settings] - Per-chat settings { voice, language }; defaults when omitted.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - caller cancellation / absolute turn deadline
 * @returns {Promise<Buffer>} OGG/Opus audio buffer (48kHz mono, iOS-optimized WhatsApp format)
 */
async function generateVoice(text, settings = {}, opts = {}) {
  const signal = signalWithTimeout(opts.signal, VOICE_GENERATION_TIMEOUT_MS);
  try {
    return await _generateVoice(text, settings, signal);
  } catch (err) {
    if (signal.aborted && !opts.signal?.aborted) {
      throw new Error(`Voice generation timeout (${VOICE_GENERATION_TIMEOUT_MS / 1000}s)`);
    }
    throw err;
  }
}

/** Guard every stage against the caller's absolute turn deadline. */
function _assertDeadline(signal) {
  if (signal?.aborted) throw new Error(`Voice generation timeout (${VOICE_GENERATION_TIMEOUT_MS / 1000}s)`);
}

async function _generateVoice(text, settings, signal) {
  const defaults = defaultSettings();
  const voice = settings?.voice || defaults.voice;
  const language = settings?.language || defaults.language;

  try {
    const mp3Buffer = await cartesiaTTS(text, voice, language, signal);
    // A null buffer means the ring has nothing left to try: expected once a
    // month, and not something to alert the administrator about.
    if (mp3Buffer) return await convertMp3ToWhatsAppOpus(mp3Buffer, { signal });
    log.info(envConfig.CARTESIA_API_KEYS.length === 0
      ? 'No Cartesia key is configured; using Microsoft Edge.'
      : 'Every Cartesia key is out of monthly credits; using Microsoft Edge.');
  } catch (err) {
    if (signal?.aborted) throw err;
    log.warn('Cartesia TTS failed, falling back to Microsoft Edge:', err.message);
    await notifyAdminDetailed('Cartesia TTS (Fallback)', err.message);
  }

  _assertDeadline(signal);

  try {
    const mp3Buffer = await edgeTTS(text, voice, language, signal);
    return await convertMp3ToWhatsAppOpus(mp3Buffer, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    const notification = await notifyAdminDetailed('Microsoft Edge TTS (Fallback)', err.message);
    throw new Error(
      `TTS failed: Cartesia is unusable and Microsoft Edge errored (${err.message}).`
      + buildAdminNotificationNote(notification)
    );
  }
}

// -- Cartesia Sonic (primary) ------------------------------------------------

/**
 * Whether a rejected request means this key has spent its monthly free credits,
 * as opposed to a transient failure that says nothing about the allowance.
 * `quota_exceeded` is Cartesia's own code for a spent allowance; 401/402/403
 * mean the key itself is no longer usable, which the ring treats the same way
 * because retrying it before the next reset can only fail again.
 */
function _keyIsSpent(status, errorCode) {
  return errorCode === 'quota_exceeded' || status === 401 || status === 402 || status === 403;
}

/**
 * Call `POST /tts/bytes` with each usable key in turn and return the MP3
 * buffer, or null when every key has spent its monthly credits.
 * A spent key is written down before the next one is tried; any other failure
 * ends the rotation, because a transient error is no reason to burn the ring.
 */
async function cartesiaTTS(text, voice, language, signal) {
  const body = JSON.stringify({
    model_id: envConfig.CARTESIA_MODEL,
    transcript: text,
    voice: cartesiaVoiceId(voice),
    language: cartesiaLanguage(language),
    output_format: { container: 'mp3', sample_rate: CARTESIA_SAMPLE_RATE, bit_rate: CARTESIA_BIT_RATE }
  });

  let entry = nextUsableKey();
  const attemptedFingerprints = new Set();
  while (entry && !attemptedFingerprints.has(entry.fingerprint)) {
    attemptedFingerprints.add(entry.fingerprint);
    _assertDeadline(signal);
    const res = await fetchWithTimeout(`${envConfig.CARTESIA_BASE_URL}/tts/bytes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${entry.key}`,
        'Cartesia-Version': envConfig.CARTESIA_VERSION,
        'Content-Type': 'application/json'
      },
      body,
      signal
    }, TTS_REQUEST_TIMEOUT_MS);

    if (res.ok) {
      const buffer = Buffer.from(await readResponseBodyWithTimeout(res.arrayBuffer(), TTS_REQUEST_TIMEOUT_MS));
      if (buffer.length === 0) throw new Error('Cartesia returned an empty audio body.');
      await markWorking(entry.fingerprint);
      return buffer;
    }

    const detail = await res.text().catch(() => '');
    let errorCode = null;
    try { errorCode = JSON.parse(detail)?.error_code || null; } catch { /* not the documented JSON error shape */ }
    if (!_keyIsSpent(res.status, errorCode)) {
      throw new Error(`Cartesia TTS failed (HTTP ${res.status}): ${detail || 'no error body'}`);
    }
    entry = await markExhausted(entry.fingerprint);
  }

  return null;
}

// -- Microsoft Edge Neural (fallback) ----------------------------------------

/**
 * Synthesize through Microsoft Edge's read-aloud service, which needs no
 * credential. The library only writes to a file, so the audio is staged in a
 * private temp directory and read back from there.
 */
async function edgeTTS(text, voice, language, signal) {
  const selected = edgeVoice(voice, language);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gemix-tts-'));
  const file = path.join(dir, 'voice.mp3');
  try {
    await runOwnedWorker(
      new URL('../media/edgeTtsWorkerThread.js', import.meta.url),
      {
        text,
        file,
        options: {
          voice: selected.voice,
          lang: selected.lang,
          outputFormat: EDGE_OUTPUT_FORMAT,
          pitch: 'default',
          rate: 'default',
          volume: 'default',
          timeout: TTS_REQUEST_TIMEOUT_MS
        }
      },
      { signal, timeoutMs: TTS_REQUEST_TIMEOUT_MS, label: 'Microsoft Edge TTS' }
    );
    _assertDeadline(signal);
    const buffer = await fs.promises.readFile(file);
    if (buffer.length === 0) throw new Error('Microsoft Edge TTS returned an empty audio file.');
    return buffer;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

export { generateVoice, convertMp3ToWhatsAppOpus
};
