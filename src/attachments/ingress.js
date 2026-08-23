// src/attachments/ingress.js
//
// What happens to a file the moment it arrives, on every platform.
//
// One rule decides everything (spec §8.6): images from the message being
// answered — or the one it replies to — go to the model inline, and nothing
// else ever does. Documents, audio, video and archives become a path the model
// can open with `read_file` when it decides it needs them, instead of being
// pushed into a window that has to hold the whole conversation.
//
// So there are exactly two outputs per file:
//
//   [Attachment: attachments/report.pdf]              always
//   { type: 'input_image', image_url: 'data:…' }      images, inline, capped
//
// No file is uploaded anywhere to reach the model: the image travels as base64
// in the request, and everything else never leaves the host. Nothing here
// produces a public URL, which is what retires tmpfile.link from the model path.
//
// The tag and the file are one thing: whatever this returns as a tag has been
// materialized under `attachments/`, or is marked `(expired)` because it could
// not be. There is no third state where the model reads a path that is not
// there.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { mimeBase } from '../config/mimeExtensions.js';
import { isNonReadableExt } from '../config/nonReadableExts.js';
import { syncFileToHistory, getUserHistoryPaths } from '../utils/historySync.js';
import {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  resolveMediaDurationSec
} from '../utils/mediaIngressLimits.js';
import { INLINE_IMAGE_EXTS, inlineImagePart } from '../tools/workspace/inlineImage.js';
import { attachmentDisplayPath, projectBuffer, projectFile } from './projection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AttachmentIngress');

const AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);

/** How many images may travel inline in one turn. */
const MAX_INLINE_IMAGES = constants.MAX_INLINE_IMAGES_PER_TURN;

function _extOf(name) {
  return path.extname(name || '').toLowerCase();
}

/** Which duration gate applies, if any. */
function mediaKindFor(name, contentType = '') {
  const ext = _extOf(name);
  const base = mimeBase(contentType);
  if (AUDIO_EXTS.has(ext) || base.startsWith('audio/')) return 'audio';
  if (VIDEO_EXTS.has(ext) || base.startsWith('video/')) return 'video';
  return 'other';
}

/** True when this is an image the model's vision can read directly. */
function isInlineableImage(name, contentType = '') {
  return INLINE_IMAGE_EXTS.has(_extOf(name)) || mimeBase(contentType).startsWith('image/');
}

/**
 * The tag for one file, in the shared path namespace.
 * @param {string} name - the projected filename
 * @param {boolean} [expired] - the raw is gone and could not be recovered
 */
function buildAttachmentTag(name, expired = false) {
  const label = expired ? 'Attachment (expired)' : 'Attachment';
  return `[${label}: ${attachmentDisplayPath(name)}]`;
}

/** Absolute path of a file inside a conversation's history directory. */
function resolveHistoryAbsPath(historyStorageId, historyName) {
  const uid = typeof historyStorageId === 'string' ? historyStorageId.trim() : '';
  const rel = typeof historyName === 'string' ? historyName.trim() : '';
  if (!uid || !rel) return null;
  const base = path.basename(rel.replace(/^history\//, ''));
  if (!base || base === '.' || base === '..') return null;
  const { historyDir } = getUserHistoryPaths(uid);
  const abs = path.join(historyDir, base);
  return fs.existsSync(abs) ? abs : null;
}

function _tagResult(name, { expired = false, note = '' } = {}) {
  const tag = buildAttachmentTag(name, expired);
  return {
    tag,
    name,
    contentParts: [],
    textFragment: note ? `${tag}${note} ` : `${tag} `
  };
}

/**
 * Materialize one file into the projection, re-downloading from the platform
 * when the durable copy is gone.
 *
 * @returns {Promise<{ name: string, abs: string }|null>}
 */
async function _materialize(opts) {
  const { workspaceId, historyStorageId, syncedPath, name, fetchBuffer } = opts;

  const historyAbs = syncedPath ? resolveHistoryAbsPath(historyStorageId, syncedPath) : null;
  if (historyAbs) {
    const projected = projectFile(workspaceId, historyAbs, path.basename(syncedPath));
    if (projected) return projected;
  }

  // Rehydration: the local raw expired (or never landed) but the platform can
  // still hand it back. Recovering here is what keeps a returning history entry
  // a live tag instead of an expired one.
  if (typeof fetchBuffer !== 'function') return null;
  let buffer;
  try { buffer = await fetchBuffer(); }
  catch (err) {
    log.debug(`Rehydration of ${name} failed: ${err.message}`);
    return null;
  }
  if (!buffer || !buffer.length) return null;

  let finalName = syncedPath ? path.basename(syncedPath) : path.basename(name || 'file');
  if (historyStorageId && opts.platformAttachmentId) {
    try {
      const saved = await syncFileToHistory(historyStorageId, opts.platformAttachmentId, async () => buffer, finalName);
      if (saved) finalName = path.basename(saved);
    } catch (err) {
      log.debug(`History sync failed for ${finalName}: ${err.message}`);
    }
  }
  return projectBuffer(workspaceId, finalName, buffer);
}

/**
 * Turn one incoming or historical attachment into its tag plus, for an inline
 * image, the content part the model can look at.
 *
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.historyStorageId
 * @param {string|null} opts.syncedPath - history filename, when already synced
 * @param {string} opts.name
 * @param {string} [opts.contentType]
 * @param {Function} [opts.fetchBuffer] - async () => Buffer|null
 * @param {number} [opts.metadataDurationSec]
 * @param {string} [opts.platformAttachmentId]
 * @param {boolean} [opts.inline] - current message or the one it replies to
 * @param {number} [opts.imagesInlined] - running per-turn count
 * @returns {Promise<{ tag, name, syncedPath, contentParts, textFragment, bumpImageCount? }>}
 */
async function ingestAttachment(opts) {
  const {
    name,
    contentType = '',
    syncedPath = null,
    metadataDurationSec = 0,
    inline = false,
    imagesInlined = 0
  } = opts;

  const displayName = path.basename(syncedPath || name || 'file');

  // Raw binaries are never readable by anything, so they stay a bare tag and
  // are not worth a copy into the projection.
  if (isNonReadableExt(_extOf(displayName))) {
    return { ..._tagResult(displayName), syncedPath };
  }

  // Duration gates run before anything is copied, so an over-long clip costs
  // one probe rather than a projection entry that read_file would refuse.
  const kind = mediaKindFor(displayName, contentType);
  if (kind === 'audio' || kind === 'video') {
    try {
      const historyAbsPath = syncedPath ? resolveHistoryAbsPath(opts.historyStorageId, syncedPath) : null;
      let probeBuffer = null;
      if (!historyAbsPath && !(Number(metadataDurationSec) > 0) && typeof opts.fetchBuffer === 'function') {
        probeBuffer = await opts.fetchBuffer();
      }
      const dur = await resolveMediaDurationSec({
        metadataSec: metadataDurationSec,
        buffer: probeBuffer,
        extHint: _extOf(displayName).slice(1),
        historyAbsPath
      });
      if (kind === 'audio' && isAudioOverDurationLimit(dur)) {
        return { ..._tagResult(displayName, { note: formatAudioTooLongNote(dur) }), syncedPath, overDurationLimit: 'audio', durationNote: formatAudioTooLongNote(dur).trim() };
      }
      if (kind === 'video' && isVideoOverDurationLimit(dur)) {
        return { ..._tagResult(displayName, { note: formatVideoTooLongNote(dur) }), syncedPath, overDurationLimit: 'video', durationNote: formatVideoTooLongNote(dur).trim() };
      }
    } catch { /* fall through and project it anyway */ }
  }

  const materialized = await _materialize(opts);
  if (!materialized) {
    // The invariant in its explicit form: no live tag without a file.
    return { ..._tagResult(displayName, { expired: true }), syncedPath };
  }

  const finalName = materialized.name;
  const result = { ..._tagResult(finalName), syncedPath: syncedPath || finalName };

  if (!inline || !isInlineableImage(finalName, contentType)) return result;
  if (imagesInlined >= MAX_INLINE_IMAGES) {
    return {
      ...result,
      textFragment: `${result.tag} (not shown inline this turn — read_file to look at it) `
    };
  }

  const part = inlineImagePart(materialized.abs);
  if (!part) return result;
  return { ...result, contentParts: [part], bumpImageCount: true };
}

export {
  MAX_INLINE_IMAGES,
  AUDIO_EXTS,
  VIDEO_EXTS,
  buildAttachmentTag,
  resolveHistoryAbsPath,
  mediaKindFor,
  isInlineableImage,
  ingestAttachment
};
