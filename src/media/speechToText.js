// src/media/speechToText.js
//
// Transcription of voice notes, as a GemiX service rather than a model
// capability.
//
// The main model never hears audio: whatever provider is active, a voice note
// reaches it as text produced here. That keeps a user's
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
import { CF_ERROR, callWorkersAi, isCloudflareConfigured } from './cloudflareClient.js';
import { estimateSttNeurons } from './neuronLedger.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('STT');

/** The only outcomes a caller has to handle. */
const STT_STATUS = Object.freeze({
  OK: 'ok',
  NO_SPEECH: 'no_speech',
  TOO_LONG: 'too_long',
  CONTENT_POLICY: 'content_policy',
  TIMEOUT: 'timeout',
  UNCONFIGURED: 'unconfigured',
  ERROR: 'error'
});

/** Backend ids are identical to the feature-binding vocabulary. */
const STT_BACKEND = Object.freeze({
  XAI: 'xai-stt',
  CLOUDFLARE: 'cloudflare-whisper'
});

const STT_UNCONFIGURED_MESSAGE =
  'Voice transcription is not configured on this deployment, so the spoken contents of this clip are unknown.';

const REQUEST_TIMEOUT_MS = 120 * 1000;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
/** Audio bigger than this is not worth base64-ing into a JSON body. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

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
  if (bound === STT_BACKEND.XAI && isXaiSttConfigured()) return bound;
  const candidate = bound === STT_BACKEND.XAI ? fallbackBackendFor(bound) : bound;
  if (candidate === STT_BACKEND.CLOUDFLARE && isCloudflareConfigured()) return candidate;
  return null;
}

/** True when some backend can transcribe on this deployment. */
function isSttConfigured() {
  return resolveSttBackend() !== null;
}

/** Normalize a BCP-47 hint for cache comparison without changing API input. */
function normalizeSttLanguage(language) {
  return String(language || '').trim().toLowerCase();
}

/** The concrete model used by one backend. */
function sttModelId(backend = resolveSttBackend()) {
  if (backend === STT_BACKEND.XAI) return `xai:${envConfig.XAI_STT_PATH}`;
  if (backend === STT_BACKEND.CLOUDFLARE) return envConfig.CLOUDFLARE_STT_MODEL;
  return 'unconfigured';
}

/**
 * The configured transcription chain. Cache entries remain valid when the
 * primary temporarily falls back, but not after the chain itself changes.
 */
function sttRouteId() {
  const primary = resolveSttBackend();
  if (!primary) return 'unconfigured';
  const route = [sttModelId(primary)];
  if (primary === STT_BACKEND.XAI && isCloudflareConfigured()) {
    route.push(sttModelId(STT_BACKEND.CLOUDFLARE));
  }
  return route.join('>');
}

/** Outcomes that are deterministic for the same bytes, route and language. */
function isCacheableSttStatus(status) {
  return status === STT_STATUS.OK
    || status === STT_STATUS.NO_SPEECH
    || status === STT_STATUS.TOO_LONG
    || status === STT_STATUS.CONTENT_POLICY;
}

/** Identifier for the cache: same bytes and same model means same transcript. */
function contentHashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

function _result(status, provider, extra = {}) {
  return { status, text: '', provider, model: sttModelId(provider), ...extra };
}

/**
 * Re-encode to the one format every backend accepts. Used only after the
 * original file was refused, so a working upload is never transcoded twice.
 * @returns {Promise<Buffer|null>}
 */
function _toWav16k(absPath, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const outPath = path.join(tempDirForOwner(null), `stt_${crypto.randomBytes(8).toString('hex')}.wav`);
    let child;
    try {
      child = spawn(envConfig.FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', absPath,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        outPath
      ]);
    } catch { return resolve(null); }
    // Both pipes have to be read or ffmpeg blocks once the OS buffer fills and
    // only the kill timer below would ever end it.
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
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

/**
 * Whatever the backend called the transcript. A missing field is a malformed
 * response, while a present but empty string is a deterministic silent clip.
 * @returns {{ok: true, text: string}|{ok: false}}
 */
function _extractTranscript(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false };
  const candidate = payload?.result?.text ?? payload?.text ?? payload?.transcript;
  if (typeof candidate !== 'string') return { ok: false };
  return { ok: true, text: candidate.trim() };
}

/**
 * Timed segments, when the backend returned them.
 *
 * A video transcript has to carry timings: without them the model
 * can quote what was said but not say when, which is most of what a transcript
 * is for. Whisper returns `segments`; a backend that gives only word timings is
 * grouped into lines rather than losing the clock entirely.
 *
 * @returns {Array<{start: number, text: string}>}
 */
function _extractSegments(payload) {
  const root = payload?.result ?? payload ?? {};

  if (Array.isArray(root.segments) && root.segments.length > 0) {
    return root.segments
      .map((seg) => ({ start: Number(seg?.start), text: String(seg?.text ?? '').trim() }))
      .filter((seg) => Number.isFinite(seg.start) && seg.text);
  }

  if (Array.isArray(root.words) && root.words.length > 0) {
    const WORDS_PER_LINE = 14;
    const out = [];
    for (let i = 0; i < root.words.length; i += WORDS_PER_LINE) {
      const chunk = root.words.slice(i, i + WORDS_PER_LINE);
      const start = Number(chunk[0]?.start);
      const text = chunk.map((w) => String(w?.word ?? '').trim()).filter(Boolean).join(' ').trim();
      if (Number.isFinite(start) && text) out.push({ start, text });
    }
    return out;
  }

  return [];
}

// -- Cloudflare Workers AI (Whisper) -----------------------------------------

async function _cloudflarePost(buffer, opts) {
  return callWorkersAi({
    model: envConfig.CLOUDFLARE_STT_MODEL,
    body: {
      audio: buffer.toString('base64'),
      task: 'transcribe',
      ...(opts.language ? { language: opts.language } : {}),
      vad_filter: true,
      beam_size: 5,
      condition_on_previous_text: false
    },
    estimatedNeurons: estimateSttNeurons(opts.durationSec),
    signal: opts.signal,
    timeoutMs: REQUEST_TIMEOUT_MS
  });
}

async function _transcribeCloudflare(absPath, buffer, opts) {
  let attempt = await _cloudflarePost(buffer, opts);

  // A refused container is worth exactly one re-encode, never two. A rejected
  // budget or a rate limit is not about the container, so it is not re-encoded.
  if (!attempt.ok && attempt.code === CF_ERROR.MALFORMED) {
    const wav = await _toWav16k(absPath, opts.signal);
    if (wav) attempt = await _cloudflarePost(wav, opts);
  }

  if (!attempt.ok) {
    log.warn(`Workers AI refused the clip (${attempt.code}): ${attempt.error}`);
    const status = attempt.code === CF_ERROR.TRANSIENT && /in time/.test(attempt.error || '')
      ? STT_STATUS.TIMEOUT
      : STT_STATUS.ERROR;
    return { ..._result(status, STT_BACKEND.CLOUDFLARE), message: attempt.error };
  }
  const extracted = _extractTranscript(attempt.payload);
  if (!extracted.ok) {
    return {
      ..._result(STT_STATUS.ERROR, STT_BACKEND.CLOUDFLARE),
      message: 'Workers AI returned an unreadable transcription response.'
    };
  }
  return extracted.text
    ? { ..._result(STT_STATUS.OK, STT_BACKEND.CLOUDFLARE), text: extracted.text, segments: _extractSegments(attempt.payload) }
    : _result(STT_STATUS.NO_SPEECH, STT_BACKEND.CLOUDFLARE);
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
    maxAttempts: 2,
    signal: opts.signal
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* handled below */ }
  const extracted = _extractTranscript(payload);
  if (!extracted.ok) {
    return {
      ..._result(STT_STATUS.ERROR, STT_BACKEND.XAI),
      message: 'xAI returned an unreadable transcription response.'
    };
  }
  return extracted.text
    ? { ..._result(STT_STATUS.OK, STT_BACKEND.XAI), text: extracted.text, segments: _extractSegments(payload) }
    : _result(STT_STATUS.NO_SPEECH, STT_BACKEND.XAI);
}

/** A refusal about the content itself, which no other backend will reverse. */
function _isContentPolicyRefusal(err) {
  return /content[_ -]?policy|safety|moderation|inappropriate|not allowed/i.test(err?.message || '');
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

  let size;
  try { size = fs.statSync(absPath).size; }
  catch (err) {
    log.warn(`Cannot read ${path.basename(absPath)} for transcription: ${err.message}`);
    return _result(STT_STATUS.ERROR, backend);
  }
  if (size === 0) return _result(STT_STATUS.ERROR, backend);
  if (size > MAX_AUDIO_BYTES) return _result(STT_STATUS.TOO_LONG, backend);

  let buffer;
  try { buffer = fs.readFileSync(absPath); }
  catch (err) {
    log.warn(`Cannot read ${path.basename(absPath)} for transcription: ${err.message}`);
    return _result(STT_STATUS.ERROR, backend);
  }

  try {
    if (backend === STT_BACKEND.XAI) {
      try {
        return await _transcribeXai(absPath, buffer, opts);
      } catch (err) {
        // The whole point of the binding's fallback: a refusal from xAI must
        // not cost the user their transcript when Cloudflare can still do it.
        // Two exceptions: an aborted turn is not a backend failure,
        // and a content-policy refusal is a decision no second backend should
        // be asked to overturn.
        if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
        if (_isContentPolicyRefusal(err)) {
          log.warn('xAI refused the clip on content policy; not retrying elsewhere');
          return { ..._result(STT_STATUS.CONTENT_POLICY, STT_BACKEND.XAI), message: err.message };
        }
        if (!isCloudflareConfigured()) throw err;
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
  STT_BACKEND,
  STT_STATUS,
  STT_UNCONFIGURED_MESSAGE,
  contentHashOf,
  isSttConfigured,
  isCacheableSttStatus,
  normalizeSttLanguage,
  sttModelId,
  sttRouteId,
  transcribeAudioFile,
  _extractTranscript
};
