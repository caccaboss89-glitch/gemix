// src/utils/mediaIngressLimits.js
//
// Shared duration caps for media entering the model (current message,
// chat history). Byte caps live in aiFileDelivery.js.
// Discord downloads: 25 MB (discordAttachmentFetch.js).

import fs from 'fs';
import constants from '../config/constants.js';
import { getMediaDurationSec, getMediaDurationSecFromPath  } from './mediaDuration.js';

function formatAudioTooLongNote(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= constants.MAX_AUDIO_DURATION_S) return '';
  return ` (audio too long: ${Math.round(d)}s, max ${constants.MAX_AUDIO_DURATION_S}s)`;
}

function formatVideoTooLongNote(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= constants.MAX_VIDEO_DURATION_S) return '';
  return ` (video too long: ${Math.round(d)}s, max ${constants.MAX_VIDEO_DURATION_S}s)`;
}

function isAudioOverDurationLimit(durationSec) {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > constants.MAX_AUDIO_DURATION_S;
}

function isVideoOverDurationLimit(durationSec) {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > constants.MAX_VIDEO_DURATION_S;
}

/** Probe duration from a file already stored under data/users/.../history/. */
async function durationSecFromHistoryFile(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    return await getMediaDurationSecFromPath(absPath);
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
    if (d !== null && d !== undefined && Number.isFinite(d)) return d;
  }
  if (historyAbsPath) {
    const d = await durationSecFromHistoryFile(historyAbsPath);
    if (d !== null && d !== undefined && Number.isFinite(d)) return d;
  }
  return 0;
}

export {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  resolveMediaDurationSec
};

export const { MAX_AUDIO_DURATION_S, MAX_VIDEO_DURATION_S } = constants;