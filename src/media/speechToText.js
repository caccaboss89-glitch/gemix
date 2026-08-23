// src/media/speechToText.js
//
// Transcription of voice notes, as a GemiX service rather than a model
// capability.
//
// The main model never hears audio: whatever provider is active, a voice note
// reaches it as text produced here (spec §8.3, §11.4). That keeps a user's
// spoken turn readable on every profile instead of only on the ones whose
// model happens to accept audio, and it keeps the transcript on the correct
// history turn rather than appended to the next one.
//
// Backend comes from the STT feature binding, not from the provider: xAI's own
// endpoint when this deployment has one configured, Cloudflare Workers AI
// Whisper otherwise and as the fallback when xAI refuses.
//
// Every call returns one of a fixed set of statuses. There is no "probably
// said something" state: when audio cannot be transcribed the caller reports
// the status and the model is told not to guess at the contents.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { FEATURE, backendFor, fallbackBackendFor } from '../features/featureBindings.js';
import { resolveProviderProfile } from '../ai/providers/providerProfile.js';
import { fetchXaiWithOAuthRetry } from '../ai/apiClient.js';
import { getXaiServiceAuth } from '../ai/credentials/xaiServiceCredentials.js';
import { tempDirForOwner } from '../utils/tempFileServer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('STT');

/** The only outcomes a caller has to handle. */
const STT_STATUS = Object.freeze({
  OK: 'ok',
  NO_SPEECH: 'no_speech',
  TOO_LONG: 'too_long',
  TIMEOUT: 'timeout',
  UNCONFIGURED: 'unconfigured',
  ERROR: 'error'
});

const STT_UNCONFIGURED_MESSAGE =
  'Voice transcription is not configured on this deployment, so the spoken contents of this clip are unknown.';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const REQUEST_TIMEOUT_MS = 120 * 1000;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
/** Audio bigger than this is not worth base64-ing into a JSON body. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** True when the deployment has Workers AI credentials. */
function isCloudflareSttConfigured() {
  return Boolean(envConfig.CLOUDFLARE_AI_ACCOUNT_ID && envConfig.CLOUDFLARE_AI_API_TOKEN);
}

/** True when this deployment knows where xAI's transcription endpoint lives. */
function isXaiSttConfigured() {
  return Boolean(envConfig.XAI_STT_PATH);
}

/**
 * The backend that will actually run, after the feature binding and the
 * fallback are both taken into account.
 * @returns {string|null} null when nothing is usable
 */
function resolveSttBackend() {
  const bound = backendFor(resolveProviderProfile(), FEATURE.STT);
  if (bound === 'xai-stt' && isXaiSttConfigured()) return bound;
  const candidate = bound === 'xai-stt' ? fallbackBackendFor(bound) : bound;
  if (candidate === 'cloudflare-whisper' && isCloudflareSttConfigured()) return candidate;
  return null;
}

/** True when some backend can transcribe on this deployment. */
function isSttConfigured() {
  return resolveSttBackend() !== null;
}

/** The model that produced a transcript, and half of the cache key. */
function sttModelId() {
  return resolveSttBackend() === 'xai-stt'
    ? `xai:${envConfig.XAI_STT_PATH}`
    : envConfig.CLOUDFLARE_STT_MODEL;
}

/** Identifier for the cache: same bytes and same model means same transcript. */
function contentHashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

function _result(status, provider, extra = {}) {
  return { status, text: '', provider, model: sttModelId(), ...extra };
}

/**
 * Re-encode to the one format every backend accepts. Used only after the
 * original file was refused, so a working upload is never transcoded twice.
 * @returns {Promise<Buffer|null>}
 */
function _toWav16k(absPath, signal) {
  return new Promise((resolve) => {
    const outPath = path.join(tempDirForOwner(null), `stt_${crypto.randomBytes(8).toString('hex')}.wav`);
    const child = spawn(envConfig.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', absPath,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      outPath
    ]);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, FFMPEG_TIMEOUT_MS);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const finish = (buffer) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { fs.unlinkSync(outPath); } catch { /* never written */ }
      resolve(buffer);
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try { finish(fs.readFileSync(outPath)); }
      catch { finish(null); }
    });
  });
}

/** Whatever the backend called the transcript. */
function _extractTranscript(payload) {
  const candidate = payload?.result?.text ?? payload?.text ?? payload?.transcript;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

// -- Cloudflare Workers AI (Whisper) -----------------------------------------

async function _cloudflarePost(buffer, opts) {
  const model = envConfig.CLOUDFLARE_STT_MODEL;
  const url = `${CLOUDFLARE_API_BASE}/${envConfig.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${model}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${envConfig.CLOUDFLARE_AI_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio: buffer.toString('base64'),
      task: 'transcribe',
      ...(opts.language ? { language: opts.language } : {}),
      vad_filter: true,
      beam_size: 5,
      condition_on_previous_text: false
    }),
    signal: opts.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* reported below */ }
  return { ok: res.ok, status: res.status, payload, raw: text };
}

async function _transcribeCloudflare(absPath, buffer, opts) {
  let attempt = await _cloudflarePost(buffer, opts);

  // A refused container is worth exactly one re-encode, never two.
  if (!attempt.ok && attempt.status >= 400 && attempt.status < 500) {
    const wav = await _toWav16k(absPath, opts.signal);
    if (wav) attempt = await _cloudflarePost(wav, opts);
  }

  if (!attempt.ok) {
    const detail = attempt.payload?.errors?.[0]?.message || attempt.raw.slice(0, 200);
    log.warn(`Workers AI refused the clip (HTTP ${attempt.status}): ${detail}`);
    return _result(STT_STATUS.ERROR, 'cloudflare');
  }
  const transcript = _extractTranscript(attempt.payload);
  return transcript
    ? { ..._result(STT_STATUS.OK, 'cloudflare'), text: transcript }
    : _result(STT_STATUS.NO_SPEECH, 'cloudflare');
}

// -- xAI ----------------------------------------------------------------------

async function _transcribeXai(absPath, buffer, opts) {
  const { baseUrl } = await getXaiServiceAuth();
  const url = `${baseUrl}${envConfig.XAI_STT_PATH.startsWith('/') ? '' : '/'}${envConfig.XAI_STT_PATH}`;
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(absPath));
  if (opts.language) form.append('language', opts.language);

  const res = await fetchXaiWithOAuthRetry(url, { method: 'POST', body: form }, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxAttempts: 2
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* handled below */ }
  const transcript = _extractTranscript(payload);
  return transcript
    ? { ..._result(STT_STATUS.OK, 'xai'), text: transcript }
    : _result(STT_STATUS.NO_SPEECH, 'xai');
}

// -- Public entry point --------------------------------------------------------

/**
 * Transcribe one audio file.
 *
 * @param {string} absPath
 * @param {object} [opts]
 * @param {number} [opts.durationSec] - checked against the ingress duration cap
 * @param {string} [opts.language] - BCP-47 hint from the chat's reply language
 * @param {AbortSignal} [opts.signal] - the turn's signal
 * @returns {Promise<{status: string, text: string, provider: string, model: string, message?: string}>}
 */
async function transcribeAudioFile(absPath, opts = {}) {
  const backend = resolveSttBackend();
  if (!backend) {
    return { ..._result(STT_STATUS.UNCONFIGURED, 'none'), message: STT_UNCONFIGURED_MESSAGE };
  }
  if (Number(opts.durationSec) > constants.MAX_AUDIO_DURATION_S) {
    return _result(STT_STATUS.TOO_LONG, backend);
  }

  let buffer;
  try { buffer = fs.readFileSync(absPath); }
  catch (err) {
    log.warn(`Cannot read ${path.basename(absPath)} for transcription: ${err.message}`);
    return _result(STT_STATUS.ERROR, backend);
  }
  if (buffer.length === 0) return _result(STT_STATUS.ERROR, backend);
  if (buffer.length > MAX_AUDIO_BYTES) return _result(STT_STATUS.TOO_LONG, backend);

  try {
    if (backend === 'xai-stt') {
      try {
        return await _transcribeXai(absPath, buffer, opts);
      } catch (err) {
        // The whole point of the binding's fallback: a refusal from xAI must
        // not cost the user their transcript when Cloudflare can still do it.
        if (!isCloudflareSttConfigured()) throw err;
        log.warn(`xAI transcription failed (${err.message}); falling back to Workers AI`);
        return await _transcribeCloudflare(absPath, buffer, opts);
      }
    }
    return await _transcribeCloudflare(absPath, buffer, opts);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return _result(STT_STATUS.TIMEOUT, backend);
    }
    log.warn(`Transcription failed for ${path.basename(absPath)}: ${err.message}`);
    return _result(STT_STATUS.ERROR, backend);
  }
}

export {
  STT_STATUS,
  STT_UNCONFIGURED_MESSAGE,
  MAX_AUDIO_BYTES,
  contentHashOf,
  isSttConfigured,
  isCloudflareSttConfigured,
  isXaiSttConfigured,
  resolveSttBackend,
  sttModelId,
  transcribeAudioFile
};
