// src/parsers/mediaParser.js
//
// Images, audio and video for `read_file` (spec §7.3, §8.2, §9).
//
// Each of the three answers a different question:
//
//   image → the model already sees it; what it cannot see is the file itself,
//           so this returns dimensions, format and colour space
//   audio → the words, from the STT backend; on music or ambient sound the
//           transcript is legitimately empty and says so (§8.5)
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
import { STT_STATUS, transcribeAudioFile } from '../media/speechToText.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MediaParser');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.ico']);
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac', '.amr', '.wma']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv']);

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
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

/** A private scratch dir for one parse, removed whatever happens. */
function _scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-parse-'));
}

function _runFfmpeg(args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(envConfig.FFMPEG_PATH, args); }
    catch (err) { return resolve({ ok: false, error: err.message }); }

    let stderr = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 2000); });
    child.stdout.on('data', () => { /* drained so ffmpeg does not block */ });
    child.on('error', (err) => { clearTimeout(killer); resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split('\n').pop() || `ffmpeg exited ${code}` });
    });
  });
}

/** mm:ss for a position in a clip, which is how a transcript is worth reading. */
function _timecode(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
function _sttOutcome(result, durationSec) {
  const notes = [];
  if (result.status === STT_STATUS.OK && result.text) {
    return { content: result.text, notes };
  }
  if (result.status === STT_STATUS.NO_SPEECH) {
    notes.push('No speech in this audio. That does not mean it is silent — music, ambient sound and '
      + 'tone are not transcribed, so work from the file itself if that is what matters.');
  } else if (result.status === STT_STATUS.TOO_LONG) {
    notes.push(`This is ${_timecode(durationSec)} long, past the transcription limit. Cut a segment with shell and read that.`);
  } else if (result.status === STT_STATUS.UNCONFIGURED) {
    notes.push(result.message || 'Speech-to-text is not configured on this deployment.');
  } else {
    notes.push(result.message || 'Transcription failed for this file.');
  }
  return { content: '', notes };
}

/** Audio: what was said, or an honest note about why there is nothing. */
async function parseAudio(absPath, opts = {}) {
  const durationSec = await getMediaDurationSecFromPath(absPath).catch(() => 0);
  const result = await transcribeAudioFile(absPath, {
    durationSec,
    language: opts.language,
    signal: opts.signal
  });
  const { content, notes } = _sttOutcome(result, durationSec);
  return {
    ok: true,
    kind: 'audio',
    content,
    metadata: {
      durationSec: durationSec || undefined,
      duration: durationSec ? _timecode(durationSec) : undefined,
      transcriptStatus: result.status,
      transcribedBy: result.provider || undefined
    },
    notes
  };
}

/** Pull the audio track out as a mono 16 kHz wav, which is what STT wants anyway. */
async function _extractAudioTrack(absPath, dir) {
  const wav = path.join(dir, 'track.wav');
  const run = await _runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', absPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav
  ]);
  if (!run.ok) return { ok: false, error: run.error };
  try {
    return fs.statSync(wav).size > 0 ? { ok: true, wav } : { ok: false, error: 'the clip has no audio track' };
  } catch {
    return { ok: false, error: 'the clip has no audio track' };
  }
}

/** Sample frames evenly across the clip, so the whole thing is represented. */
async function _extractFrames(absPath, dir, durationSec, wanted) {
  const frames = [];
  const count = Math.max(1, Math.min(wanted, constants.PARSE_MAX_VIDEO_FRAMES));
  // Offsets sit at the middle of each slice: the first frame of a video is
  // often a black or title frame and says nothing about the content.
  for (let i = 0; i < count; i++) {
    const at = durationSec > 0 ? (durationSec * (i + 0.5)) / count : 0;
    const out = path.join(dir, `frame_${i}.jpg`);
    const run = await _runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', at.toFixed(2), '-i', absPath, '-frames:v', '1',
      '-vf', 'scale=\'min(1024,iw)\':-2', '-q:v', '4', out
    ], 30_000);
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
  const durationSec = await getMediaDurationSecFromPath(absPath).catch(() => 0);
  if (durationSec > constants.MAX_VIDEO_DURATION_S) {
    return {
      ok: false,
      error: `This video is ${_timecode(durationSec)} long, over the ${constants.MAX_VIDEO_DURATION_S}s limit. `
        + 'Cut the part you need with shell and read that instead.'
    };
  }

  const dir = _scratchDir();
  const notes = [];
  let content = '';
  let transcriptStatus = 'skipped';
  let transcribedBy;

  try {
    const track = await _extractAudioTrack(absPath, dir);
    if (track.ok) {
      const result = await transcribeAudioFile(track.wav, {
        durationSec,
        language: opts.language,
        signal: opts.signal
      });
      transcriptStatus = result.status;
      transcribedBy = result.provider || undefined;
      const outcome = _sttOutcome(result, durationSec);
      content = outcome.content;
      notes.push(...outcome.notes);
    } else {
      transcriptStatus = STT_STATUS.NO_SPEECH;
      notes.push(`No transcript: ${track.error}.`);
    }

    const frames = await _extractFrames(absPath, dir, durationSec, constants.PARSE_MAX_VIDEO_FRAMES);
    if (frames.length === 0) notes.push('No frames could be extracted from this clip.');
    else notes.push(`${frames.length} frame(s) sampled across the clip, labelled with their timecode.`);

    return {
      ok: true,
      kind: 'video',
      content,
      metadata: {
        durationSec: durationSec || undefined,
        duration: durationSec ? _timecode(durationSec) : undefined,
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
  IMAGE_EXTS,
  VIDEO_EXTS,
  familyOf,
  parseAudio,
  parseImage,
  parseVideo
};
