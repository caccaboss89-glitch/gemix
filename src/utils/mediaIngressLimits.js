// src/utils/mediaIngressLimits.js
//
// Shared duration caps for media entering the model (current message,
// chat history). Byte caps live in aiFileDelivery.js.
// Discord downloads: 25 MB (discordAttachmentFetch.js).

const fs = require('fs');
const { MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S } = require('../config/constants');
const { getMediaDurationSec } = require('./mediaDuration');

function formatAudioTooLongNote(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= MAX_AUDIO_DURATION_S) return '';
  return ` (audio too long: ${Math.round(d)}s, max ${MAX_AUDIO_DURATION_S}s)`;
}

function formatVideoTooLongNote(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= MAX_VIDEO_DURATION_S) return '';
  return ` (video too long: ${Math.round(d)}s, max ${MAX_VIDEO_DURATION_S}s)`;
}

function isAudioOverDurationLimit(durationSec) {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > MAX_AUDIO_DURATION_S;
}

function isVideoOverDurationLimit(durationSec) {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > MAX_VIDEO_DURATION_S;
}

/** Probe duration from a file already stored under data/users/.../history/. */
async function durationSecFromHistoryFile(absPath, extHint) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    const buf = fs.readFileSync(absPath);
    return await getMediaDurationSec(buf, extHint);
  } catch {
    return null;
  }
}

/** Metadata duration when present; otherwise ffprobe on buffer or history file. */
async function resolveMediaDurationSec({ metadataSec = 0, buffer = null, extHint = '', historyAbsPath = null }) {
  const meta = Number(metadataSec);
  if (Number.isFinite(meta) && meta > 0) return meta;
  if (buffer && buffer.length) {
    const d = await getMediaDurationSec(buffer, extHint);
    if (d != null && Number.isFinite(d)) return d;
  }
  if (historyAbsPath) {
    const d = await durationSecFromHistoryFile(historyAbsPath, extHint);
    if (d != null && Number.isFinite(d)) return d;
  }
  return 0;
}

module.exports = {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  durationSecFromHistoryFile,
  resolveMediaDurationSec,
  MAX_AUDIO_DURATION_S,
  MAX_VIDEO_DURATION_S,
};