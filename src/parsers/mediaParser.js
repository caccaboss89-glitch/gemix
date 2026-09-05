// src/parsers/mediaParser.js
//
// Images, audio and video for `read_file`.
//
// Each of the three answers a different question:
//
//   image → the model already sees it; what it cannot see is the file itself,
//           so this returns dimensions, format and colour space
//   audio → the words, from the STT backend; on music or ambient sound the
//           transcript is legitimately empty and says so
//   video → the words with timings, plus frames sampled across the clip, so
//           the model reads what was said and sees what it looked like
//
// ffmpeg does the video work on the host, the same binary mediaDuration.js
// already probes with. Frames are sampled at even intervals rather than by
// scene detection: an even spread is predictable, covers the whole clip, and
// costs one pass instead of two.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { getMediaDurationSecFromPath } from '../utils/mediaDuration.js';
import { STT_STATUS, isCacheableSttStatus, transcribeAudioFile } from '../media/speechToText.js';
import { PARSE_ERROR } from './parseErrors.js';
import { createLogger } from '../utils/logger.js';
import { AUDIO_EXTS, VIDEO_EXTS, mediaFamilyFor } from '../config/mediaTypes.js';

const log = createLogger('MediaParser');

/** How long ffmpeg gets to pull frames or an audio track out of one clip. */
const FFMPEG_TIMEOUT_MS = 120_000;

let _sharp = null;
let _sharpError = null;

async function _loadSharp() {
  if (_sharp) return _sharp;
  if (_sharpError) return null;
  try {
    _sharp = (await import('sharp')).default;
    return _sharp;
  } catch (err) {
    _sharpError = err;
    log.warn(`Image metadata is unavailable: ${err.message}`);
    return null;
  }
}

function familyOf(ext) {
  return mediaFamilyFor({ ext });
}

/** A private scratch dir for one parse, removed whatever happens. */
function _scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-parse-'));
}

function _runFfmpeg(args, timeoutMs = FFMPEG_TIMEOUT_MS, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, aborted: true, error: 'ffmpeg aborted' });
    let child;
    try { child = spawn(envConfig.FFMPEG_PATH, args); }
    catch (err) { return resolve({ ok: false, error: err.message }); }

    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, aborted: true, error: 'ffmpeg aborted' });
    };
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, error: `ffmpeg timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    child.stdout.on('data', () => { /* drained so ffmpeg does not block */ });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim().split('\n').pop() || `ffmpeg exited ${code}` });
    });
  });
}

/** mm:ss for a position in a clip, which is how a transcript is worth reading. */
function _timecode(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function _probeDuration(absPath, signal) {
  try {
    const duration = await getMediaDurationSecFromPath(absPath, signal);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    return null;
  }
}

/**
 * Image: dimensions and format. The picture itself is attached by the caller,
 * which already has it on disk.
 */
async function parseImage(absPath) {
  const sharp = await _loadSharp();
  if (!sharp) return { ok: true, kind: 'image', metadata: {}, notes: ['Image metadata is unavailable on this host.'] };
  try {
    const m = await sharp(absPath).metadata();
    return {
      ok: true,
      kind: 'image',
      metadata: {
        format: m.format,
        width: m.width,
        height: m.height,
        colourSpace: m.space,
        channels: m.channels,
        hasAlpha: Boolean(m.hasAlpha),
        pages: m.pages && m.pages > 1 ? m.pages : undefined
      },
      notes: []
    };
  } catch (err) {
    return { ok: true, kind: 'image', metadata: {}, notes: [`Could not read image metadata: ${err.message}`] };
  }
}

/** Turn an STT outcome into the content and the note that go with it. */
/**
 * The transcript as the model should read it.
 *
 * `timed` asks for one line per segment prefixed with its timecode, which is
 * what a video transcript needs to be useful: quoting a line is
 * half the answer, saying when it was said is the other half. A backend that
 * returned no segments falls back to plain text rather than inventing timings.
 */
function _sttOutcome(result, durationSec, { timed = false } = {}) {
  const notes = [];
  if (result.status === STT_STATUS.OK && result.text) {
    if (timed && Array.isArray(result.segments) && result.segments.length > 0) {
      const lines = result.segments.map((seg) => `[${_timecode(seg.start)}] ${seg.text}`);
      return { content: lines.join('\n'), notes };
    }
    if (timed) notes.push('The transcript has no timings: this backend returned plain text.');
    return { content: result.text, notes };
  }
  if (result.status === STT_STATUS.NO_SPEECH) {
    notes.push('No speech in this audio. That does not mean it is silent — music, ambient sound and '
      + 'tone are not transcribed, so work from the file itself if that is what matters.');
  } else if (result.status === STT_STATUS.TOO_LONG) {
    notes.push(durationSec === null
      ? 'This file is past the transcription size or duration limit. Cut a segment with shell and read that.'
      : `This is ${_timecode(durationSec)} long, past the transcription limit. Cut a segment with shell and read that.`);
  } else if (result.status === STT_STATUS.UNCONFIGURED) {
    notes.push(result.message || 'Speech-to-text is not configured on this deployment.');
  } else if (result.status === STT_STATUS.CONTENT_POLICY) {
    notes.push('This audio could not be transcribed because the speech service refused its content.');
  } else {
    notes.push(result.message || 'Transcription failed for this file.');
  }
  return { content: '', notes };
}

/** Audio: what was said, or an honest note about why there is nothing. */
async function parseAudio(absPath, opts = {}) {
  const durationSec = await _probeDuration(absPath, opts.signal);
  const result = await transcribeAudioFile(absPath, {
    durationSec,
    language: opts.language,
    signal: opts.signal
  });
  const { content, notes } = _sttOutcome(result, durationSec);
  if (durationSec === null) notes.push('The audio duration could not be determined.');
  return {
    ok: true,
    cacheable: isCacheableSttStatus(result.status),
    kind: 'audio',
    content,
    metadata: {
      durationSec: durationSec ?? undefined,
      duration: durationSec !== null ? _timecode(durationSec) : undefined,
      durationUnknown: durationSec === null ? true : undefined,
      transcriptStatus: result.status,
      transcribedBy: result.provider || undefined
    },
    notes
  };
}

/** Pull the audio track out as a mono 16 kHz wav, which is what STT wants anyway. */
async function _extractAudioTrack(absPath, dir, signal) {
  const wav = path.join(dir, 'track.wav');
  const run = await _runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', absPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav
  ], FFMPEG_TIMEOUT_MS, signal);
  if (run.aborted) throw signal?.reason || new DOMException('Aborted', 'AbortError');
  if (!run.ok) return { ok: false, error: run.error };
  try {
    return fs.statSync(wav).size > 0 ? { ok: true, wav } : { ok: false, error: 'the clip has no audio track' };
  } catch {
    return { ok: false, error: 'the clip has no audio track' };
  }
}

/** Sample frames evenly across the clip, so the whole thing is represented. */
function frameOffsets(durationSec, wanted) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const count = Math.max(1, Math.min(wanted, constants.PARSE_MAX_VIDEO_FRAMES));
  return Array.from({ length: count }, (_, index) => (durationSec * (index + 0.5)) / count);
}

async function _extractFrames(absPath, dir, durationSec, wanted, signal) {
  const frames = [];
  // Offsets sit at the middle of each slice: the first frame of a video is
  // often a black or title frame and says nothing about the content.
  for (const [i, at] of frameOffsets(durationSec, wanted).entries()) {
    const out = path.join(dir, `frame_${i}.jpg`);
    const run = await _runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', at.toFixed(2), '-i', absPath, '-frames:v', '1',
      '-vf', 'scale=\'min(1024,iw)\':-2', '-q:v', '4', out
    ], 30_000, signal);
    if (run.aborted) throw signal?.reason || new DOMException('Aborted', 'AbortError');
    if (!run.ok) break;
    try {
      const buffer = fs.readFileSync(out);
      if (buffer.length > 0) frames.push({ at, buffer, mime: 'image/jpeg', label: _timecode(at) });
    } catch { /* this offset produced nothing; keep going */ }
  }
  return frames;
}

/**
 * Video: the spoken words with timings, plus frames across the clip.
 *
 * @param {string} absPath
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function parseVideo(absPath, opts = {}) {
  const durationSec = await _probeDuration(absPath, opts.signal);
  if (durationSec !== null && durationSec > constants.MAX_VIDEO_DURATION_S) {
    return {
      ok: false,
      error_code: PARSE_ERROR.TOO_LARGE,
      error: `This video is ${_timecode(durationSec)} long, over the ${constants.MAX_VIDEO_DURATION_S}s limit. `
        + 'Cut the part you need with shell and read that instead.'
    };
  }

  const dir = _scratchDir();
  const notes = [];
  let content = '';
  let transcriptStatus;
  let transcribedBy;

  try {
    const track = await _extractAudioTrack(absPath, dir, opts.signal);
    if (track.ok) {
      const result = await transcribeAudioFile(track.wav, {
        durationSec,
        language: opts.language,
        signal: opts.signal
      });
      transcriptStatus = result.status;
      transcribedBy = result.provider || undefined;
      const outcome = _sttOutcome(result, durationSec, { timed: true });
      content = outcome.content;
      notes.push(...outcome.notes);
    } else {
      transcriptStatus = STT_STATUS.NO_SPEECH;
      notes.push(`No transcript: ${track.error}.`);
    }

    if (durationSec === null) {
      notes.push('The video duration could not be determined; only one poster frame was sampled.');
    }

    const frames = await _extractFrames(
      absPath,
      dir,
      durationSec,
      durationSec === null ? 1 : constants.PARSE_MAX_VIDEO_FRAMES,
      opts.signal
    );
    if (frames.length === 0) notes.push('No frames could be extracted from this clip.');
    else notes.push(`${frames.length} frame(s) sampled across the clip, labelled with their timecode.`);

    return {
      ok: true,
      cacheable: isCacheableSttStatus(transcriptStatus),
      kind: 'video',
      content,
      metadata: {
        durationSec: durationSec ?? undefined,
        duration: durationSec !== null ? _timecode(durationSec) : undefined,
        durationUnknown: durationSec === null ? true : undefined,
        transcriptStatus,
        transcribedBy
      },
      images: frames,
      notes
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (err) { log.debug(`scratch cleanup: ${err.message}`); }
  }
}

export {
  AUDIO_EXTS,
  VIDEO_EXTS,
  familyOf,
  frameOffsets,
  parseAudio,
  parseImage,
  parseVideo
};
