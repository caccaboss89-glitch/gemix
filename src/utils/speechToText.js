// src/utils/speechToText.js
//
// Transcription of user voice notes for the profiles whose main model cannot
// hear audio.
//
// GPT-5.6 Sol on the Codex path rejects raw audio in every form that was
// probed, so a voice note reaches it as text produced here. The backend is
// Cloudflare Workers AI Whisper Large v3 Turbo, which a real probe transcribed
// correctly from MP3, OGG/Opus, M4A/AAC and WAV; the original file is sent as
// it is and only an unknown or refused container is normalised with FFmpeg.
//
// Every outcome is one of a fixed set of statuses. There is no "probably said
// something" state: when the audio cannot be transcribed the caller reports the
// status and the model is told not to guess what was in it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { createLogger } from './logger.js';
import { tempDirForOwner } from './tempFileServer.js';
import {
  neuronsForAudioSeconds,
  reserveNeurons,
  openQuotaCircuit,
  nextRomeMidnightMs,
  STT_DAILY_LIMIT_MESSAGE
} from './cloudflareNeurons.js';

const log = createLogger('STT');

/** The only outcomes a caller has to handle. */
const STT_STATUS = {
  OK: 'ok',
  NO_SPEECH: 'no_speech',
  TOO_LONG: 'too_long',
  TIMEOUT: 'timeout',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  UNCONFIGURED: 'unconfigured',
  ERROR: 'error'
};

const STT_UNCONFIGURED_MESSAGE =
  'La trascrizione vocale non è configurata su questo GemiX; il modello non può leggere il contenuto audio.';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const REQUEST_TIMEOUT_MS = 120 * 1000;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
/** Audio bigger than this is not worth base64-ing into a JSON body. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** The model that produced a transcript, and half of the cache key. */
function sttModelId() {
  return envConfig.CLOUDFLARE_STT_MODEL;
}

/** True when the deployment has Workers AI credentials. */
function isSttConfigured() {
  return Boolean(envConfig.CLOUDFLARE_AI_ACCOUNT_ID && envConfig.CLOUDFLARE_AI_API_TOKEN);
}

/** Identifier for the cache: same bytes and same model means same transcript. */
function contentHashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

function _result(status, extra = {}) {
  return { status, text: '', provider: 'cloudflare', model: envConfig.CLOUDFLARE_STT_MODEL, ...extra };
}

/**
 * Re-encode to the one format Whisper always accepts. Used only after the
 * original file was refused, so a working upload is never transcoded twice.
 * @returns {Promise<Buffer|null>}
 */
function _toWav16k(absPath, signal) {
  return new Promise((resolve) => {
    const outPath = path.join(tempDirForOwner(null), `stt_${crypto.randomBytes(8).toString('hex')}.wav`);
    const child = spawn(envConfig.FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error',
      '-i', absPath,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-y', outPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      try { if (value === null) fs.unlinkSync(outPath); } catch { /* nothing to clean */ }
      resolve(value);
    };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const killer = setTimeout(onAbort, FFMPEG_TIMEOUT_MS);
    killer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        const buffer = fs.readFileSync(outPath);
        fs.unlinkSync(outPath);
        finish(buffer.length > 0 ? buffer : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** True when Cloudflare refused the container rather than the request. */
function _isFormatRejection(status, errorText) {
  return status === 400 && /format|decode|codec|unsupported|invalid audio/i.test(errorText);
}

/** True when the account is out of free quota. */
function _isQuotaError(status, errorText) {
  return status === 429 || /quota|neuron|limit exceeded/i.test(errorText);
}

async function _postToCloudflare(audioBuffer, language, signal) {
  const url = `${CLOUDFLARE_API_BASE}/${envConfig.CLOUDFLARE_AI_ACCOUNT_ID}/ai/run/${envConfig.CLOUDFLARE_STT_MODEL}`;
  // The turn can cancel the request, and the request cannot outlive its own
  // timeout even when the turn is patient.
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${envConfig.CLOUDFLARE_AI_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio: audioBuffer.toString('base64'),
      task: 'transcribe',
      language,
      vad_filter: true,
      condition_on_previous_text: false
    }),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline
  });

  const bodyText = await res.text();
  let payload = null;
  try { payload = JSON.parse(bodyText); } catch { /* handled below */ }

  if (!res.ok || payload?.success === false) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join('; ')
      : bodyText.slice(0, 200);
    return { ok: false, status: res.status, detail };
  }
  const text = payload?.result?.text ?? payload?.text;
  return { ok: true, text: typeof text === 'string' ? text.trim() : '' };
}

/**
 * Transcribe one user voice note.
 *
 * @param {string} absPath - the audio file on disk
 * @param {object} [opts]
 * @param {number} [opts.durationSec] - known duration, for the quota estimate
 * @param {string} [opts.language] - reply-language preference, used as a hint
 * @param {AbortSignal} [opts.signal] - the turn's signal
 * @returns {Promise<{status: string, text: string, provider: string, model: string}>}
 */
async function transcribeAudioFile(absPath, opts = {}) {
  if (!isSttConfigured()) {
    log.warn('Workers AI credentials are not configured — voice notes cannot be transcribed.');
    return _result(STT_STATUS.UNCONFIGURED, { message: STT_UNCONFIGURED_MESSAGE });
  }

  const durationSec = Number(opts.durationSec) || 0;
  if (durationSec > constants.MAX_AUDIO_DURATION_S) {
    return _result(STT_STATUS.TOO_LONG);
  }

  let audio;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size === 0) return _result(STT_STATUS.ERROR);
    if (stat.size > MAX_AUDIO_BYTES) return _result(STT_STATUS.TOO_LONG);
    audio = fs.readFileSync(absPath);
  } catch (err) {
    log.warn(`Cannot read audio for transcription: ${err.message}`);
    return _result(STT_STATUS.ERROR);
  }

  const cost = neuronsForAudioSeconds(durationSec);
  const reservation = await reserveNeurons(cost, 'stt');
  if (!reservation.ok) {
    return _result(STT_STATUS.QUOTA_EXHAUSTED, {
      denied: reservation.reason,
      message: STT_DAILY_LIMIT_MESSAGE,
      retryAt: nextRomeMidnightMs()
    });
  }

  const language = String(opts.language || 'it').split('-')[0].toLowerCase();
  try {
    let attempt = await _postToCloudflare(audio, language, opts.signal);

    if (!attempt.ok && _isFormatRejection(attempt.status, attempt.detail)) {
      const wav = await _toWav16k(absPath, opts.signal);
      if (wav) {
        // The retry is a second billable call, so it is reserved separately.
        const retryReservation = await reserveNeurons(cost, 'stt');
        if (!retryReservation.ok) {
          return _result(STT_STATUS.QUOTA_EXHAUSTED, {
            denied: retryReservation.reason,
            message: STT_DAILY_LIMIT_MESSAGE,
            retryAt: nextRomeMidnightMs()
          });
        }
        attempt = await _postToCloudflare(wav, language, opts.signal);
      }
    }

    if (!attempt.ok) {
      if (_isQuotaError(attempt.status, attempt.detail)) {
        await openQuotaCircuit();
        // The request was answered, so the reservation stands.
        log.warn(`Cloudflare STT quota exhausted (HTTP ${attempt.status}).`);
        return _result(STT_STATUS.QUOTA_EXHAUSTED, {
          message: STT_DAILY_LIMIT_MESSAGE,
          retryAt: nextRomeMidnightMs()
        });
      } else {
        log.warn(`Cloudflare STT failed (HTTP ${attempt.status}): ${attempt.detail}`);
      }
      return _result(STT_STATUS.ERROR);
    }

    if (!attempt.text) return _result(STT_STATUS.NO_SPEECH);
    return _result(STT_STATUS.OK, { text: attempt.text });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError' || opts.signal?.aborted) {
      return _result(STT_STATUS.TIMEOUT);
    }
    // A fetch failure does not prove that Cloudflare received zero bytes. Keep
    // the pessimistic reservation so a retry cannot overshoot the allowance.
    log.warn(`Cloudflare STT unreachable: ${err.message}`);
    return _result(STT_STATUS.ERROR);
  }
}

export {
  STT_STATUS,
  REQUEST_TIMEOUT_MS,
  STT_UNCONFIGURED_MESSAGE,
  sttModelId,
  isSttConfigured,
  contentHashOf,
  transcribeAudioFile
};
