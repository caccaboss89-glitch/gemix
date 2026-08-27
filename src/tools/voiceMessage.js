// src/tools/voiceMessage.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
// (This file returns binary audio Buffers, so it produces no tool-facing text.)
//
// Voice generation pipeline. Produces OGG/Opus audio buffers for WhatsApp
// voice messages. Always applies MP3-to-Opus transcode, and strips any vocal
// tags defensively before Google TTS because that backend does not support them.
//
// TTS is a delivery backend, not a model tool: the chain comes
// from the profile's TTS feature binding, so a provider with a deliberately
// integrated service is primary and Google Translate is behind it. On a profile
// with no such service, Google Translate is simply the primary — the xAI
// endpoint is not called with a credential that does not belong to it.

import googleTTS from 'google-tts-api';
import { spawn  } from 'child_process';
import { fetchWithTimeout, readResponseBodyWithTimeout  } from '../utils/fetch.js';
import { fetchXaiWithOAuthRetry  } from '../ai/apiClient.js';
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';
import { createLogger  } from '../utils/logger.js';
import { defaultSettings  } from '../utils/settingsStore.js';
import envConfig from '../config/env.js';
import { getXaiServiceAuth  } from '../ai/credentials/xaiServiceCredentials.js';
import { FEATURE, backendFor  } from '../features/featureBindings.js';
import { resolveProviderProfile  } from '../ai/providers/providerProfile.js';
import { signalWithTimeout } from '../utils/turnBudget.js';

const log = createLogger('TTS');

// xAI TTS request timeout (usually completes in a few seconds).
const TTS_REQUEST_TIMEOUT_MS = 90 * 1000;

// Overall voice generation timeout covering TTS and transcode. On expiry, the call fails rather than hanging.
const VOICE_GENERATION_TIMEOUT_MS = 120 * 1000;

// Fixed xAI TTS output format (transcoded to OGG/Opus for WhatsApp below).
// Voice id and language come from the per-chat settings, falling back to the
// deployment defaults (envConfig.XAI_TTS_VOICE in .env, Italian).
const TTS_OUTPUT_FORMAT = { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 };

/** Language passed to the Google Translate fallback (which takes a bare code). */
function _baseLanguage(language) {
  return String(language || 'it').split('-')[0].toLowerCase();
}

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
 * Generate voice audio using the direct xAI TTS endpoint (primary) with
 * Google Translate TTS fallback.
 * Enforces a global timeout and the caller's absolute turn deadline.
 * @param {string} text - Text to convert to speech (max 1000 characters).
 *   May contain xAI speech tags ([pause], <soft>...</soft>, ...) - GemiX
 *   writes them directly; they are stripped for the Google fallback.
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

/**
 * True when xAI TTS is both bound on this profile and switched on. Both have to
 * hold: the binding says the service belongs to this provider at all, the flag
 * is the operator's own kill switch for it.
 */
function xaiTtsIsPrimary() {
  return backendFor(resolveProviderProfile(), FEATURE.TTS) === 'xai-tts'
    && Boolean(envConfig.XAI_TTS_ENABLED);
}

async function _generateVoice(text, settings, signal) {
  const defaults = defaultSettings();
  const voiceId = settings?.voice || defaults.voice || envConfig.XAI_TTS_VOICE;
  const language = settings?.language || defaults.language;
  const xaiPrimary = xaiTtsIsPrimary();

  if (xaiPrimary) {
    try {
      if (signal?.aborted) throw new Error(`Voice generation timeout (${VOICE_GENERATION_TIMEOUT_MS / 1000}s)`);
      const mp3Buffer = await xaiTTS(text, voiceId, language, signal);
      return await convertMp3ToWhatsAppOpus(mp3Buffer, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      log.warn('xAI TTS failed, falling back to Google Translate:', err.message);
      await notifyAdmin('xAI TTS (Fallback)', err.message);
    }
  }

  if (signal?.aborted) throw new Error(`Voice generation timeout (${VOICE_GENERATION_TIMEOUT_MS / 1000}s)`);

  // Google Translate TTS fallback. Strip vocal tags defensively before use,
  // as the text may contain vocal tags. It has no voice selection: only the
  // language is honoured here, so the chosen voice id does not apply.
  const cleanText = stripVocalTags(text);

  try {
    return await googleTranslateTTS(cleanText, language, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!xaiPrimary) {
      // Google Translate was the primary here, so its failure is the failure.
      await notifyAdmin('Google TTS (Primary)', err.message);
      throw new Error(`TTS failed: Google Translate service error and no provider TTS is available.${ADMIN_NOTIFIED_SUFFIX}`);
    }
    throw err;
  }
}

// -- xAI TTS (direct endpoint) ----------------------------------------------

/**
 * Call `POST /v1/tts` and return the MP3 buffer. Authenticates through the
 * shared xAI CredentialProvider, same as every other xAI endpoint.
 */
async function xaiTTS(text, voiceId, language, signal) {
  const { baseUrl } = await getXaiServiceAuth();
  const res = await fetchXaiWithOAuthRetry(`${baseUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      language,
      output_format: TTS_OUTPUT_FORMAT
    })
  }, { timeoutMs: TTS_REQUEST_TIMEOUT_MS, maxAttempts: 2, signal });

  const buffer = Buffer.from(await readResponseBodyWithTimeout(res.arrayBuffer(), TTS_REQUEST_TIMEOUT_MS));
  if (buffer.length === 0) {
    throw new Error('xAI TTS returned an empty audio body.');
  }
  return buffer;
}

// -- Google Translate TTS (fallback) --------------------------------------

/**
 * Google Translate TTS fallback (no voice selection, fixed speed: normal).
 */
async function googleTranslateTTS(text, language, signal) {
  const urls = googleTTS.getAllAudioUrls(text, {
    lang: _baseLanguage(language),
    slow: false,
    host: 'https://translate.google.com'
  });

  const buffers = await Promise.all(
    urls.map(async ({ url }) => {
      if (signal?.aborted) throw new Error('TTS aborted');
      const res = await fetchWithTimeout(url, { signal });
      if (!res.ok) throw new Error(`TTS download failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    })
  );

  const mp3Buffer = Buffer.concat(buffers);
  return convertMp3ToWhatsAppOpus(mp3Buffer, { signal });
}

export { generateVoice, convertMp3ToWhatsAppOpus
};
