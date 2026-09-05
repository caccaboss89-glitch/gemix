// src/attachments/ingress.js
//
// What happens to a file the moment it arrives, on every platform.
//
// One rule decides everything: images from the message being
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
import {
  mediaFamilyFor,
  IMAGE_EXTS,
  AUDIO_EXTS,
  VIDEO_EXTS,
  INLINE_IMAGE_EXTS
} from '../config/mediaTypes.js';
import { isNonReadableExt } from '../config/nonReadableExts.js';
import { syncFileToHistory, getUserHistoryPaths } from '../utils/historySync.js';
import {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  resolveMediaDurationSec
} from '../utils/mediaIngressLimits.js';
import { inlineImagePart } from '../tools/workspace/inlineImage.js';
import { attachmentDisplayPath, projectBuffer, projectFile } from './projection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AttachmentIngress');

/** What a tag says about a file no parser can open. */
const UNREADABLE_NOTE = ' (binary — read_file cannot open it; use shell if you need to inspect it)';

/** How many images may travel inline in one turn. */
const MAX_INLINE_IMAGES = constants.MAX_INLINE_IMAGES_PER_TURN;

function _extOf(name) {
  return path.extname(name || '').toLowerCase();
}

/** Which duration gate applies, if any. */
function mediaKindFor(name, contentType = '') {
  return mediaFamilyFor({ name, contentType }) || 'other';
}

/** True when this is an image the model's vision can read directly. */
function isInlineableImage(name, contentType = '') {
  const ext = _extOf(name);
  return INLINE_IMAGE_EXTS.has(ext)
    || (!IMAGE_EXTS.has(ext) && mediaFamilyFor({ name, contentType }) === 'image');
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
 * @param {object} opts - the ingestAttachment options
 * @param {Buffer|null} [prefetched] - bytes an earlier step already pulled, so
 *   the platform is never asked for the same file twice in one ingestion
 * @returns {Promise<{ name: string, abs: string }|null>}
 */
async function _materialize(opts, prefetched = null) {
  const { workspaceId, historyStorageId, syncedPath, name, fetchBuffer, signal = null } = opts;
  signal?.throwIfAborted();

  const historyAbs = syncedPath ? resolveHistoryAbsPath(historyStorageId, syncedPath) : null;
  if (historyAbs) {
    signal?.throwIfAborted();
    const projected = projectFile(workspaceId, historyAbs, path.basename(syncedPath));
    if (projected) return projected;
  }

  // Rehydration: the local raw expired (or never landed) but the platform can
  // still hand it back. Recovering here is what keeps a returning history entry
  // a live tag instead of an expired one.
  let buffer = prefetched;
  if (!buffer) {
    if (typeof fetchBuffer !== 'function') return null;
    try { buffer = await fetchBuffer(signal); }
    catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      log.debug(`Rehydration of ${name} failed: ${err.message}`);
      return null;
    }
  }
  if (!buffer || !buffer.length) return null;
  signal?.throwIfAborted();

  let finalName = syncedPath ? path.basename(syncedPath) : path.basename(name || 'file');
  if (historyStorageId && opts.platformAttachmentId) {
    try {
      const saved = await syncFileToHistory(
        historyStorageId,
        opts.platformAttachmentId,
        async () => buffer,
        finalName,
        { signal }
      );
      if (saved) finalName = path.basename(saved);
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      log.debug(`History sync failed for ${finalName}: ${err.message}`);
    }
  }
  signal?.throwIfAborted();
  return projectBuffer(workspaceId, finalName, buffer);
}

/**
 * Turn one incoming or stored attachment into its tag plus, for an inline
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
 * @returns {Promise<{ tag, name, syncedPath, contentParts, textFragment }>}
 *   contentParts holds the inline image when there is one, and is what callers
 *   count against the per-turn cap.
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
  const signal = opts.signal || null;
  signal?.throwIfAborted();

  const displayName = path.basename(syncedPath || name || 'file');

  // Duration gates only decide what the tag *says*: an over-long clip is still
  // projected, because the invariant is tag ⇔ file and because trimming a long
  // recording with `shell` is exactly what the raw is kept for.
  const kind = mediaKindFor(displayName, contentType);
  let overDurationLimit = null;
  let durationNote = '';
  // Bytes the duration probe had to pull; handed to _materialize so one
  // ingestion never downloads the same file twice.
  let probeBuffer = null;
  if (kind === 'audio' || kind === 'video') {
    try {
      const historyAbsPath = syncedPath ? resolveHistoryAbsPath(opts.historyStorageId, syncedPath) : null;
      if (!historyAbsPath && !(Number(metadataDurationSec) > 0) && typeof opts.fetchBuffer === 'function') {
        probeBuffer = await opts.fetchBuffer(signal);
      }
      const dur = await resolveMediaDurationSec({
        metadataSec: metadataDurationSec,
        buffer: probeBuffer,
        extHint: _extOf(displayName).slice(1),
        historyAbsPath
      });
      if (kind === 'audio' && isAudioOverDurationLimit(dur)) {
        overDurationLimit = 'audio';
        durationNote = formatAudioTooLongNote(dur);
      } else if (kind === 'video' && isVideoOverDurationLimit(dur)) {
        overDurationLimit = 'video';
        durationNote = formatVideoTooLongNote(dur);
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      // A failed duration probe does not make the underlying file unreadable.
    }
  }

  // Raw binaries reach no parser, but they are still files in this chat: the
  // model can hash, unpack or inspect one with `shell`. Keep the tag paired with
  // its stored file so later tools can access it.
  const unreadable = isNonReadableExt(_extOf(displayName));
  const note = unreadable ? UNREADABLE_NOTE : durationNote;

  const materialized = await _materialize(opts, probeBuffer);
  signal?.throwIfAborted();
  if (!materialized) {
    // The invariant in its explicit form: no live tag without a file.
    return { ..._tagResult(displayName, { expired: true }), syncedPath };
  }

  const finalName = materialized.name;
  const result = { ..._tagResult(finalName, { note }), syncedPath: syncedPath || finalName };
  if (overDurationLimit) {
    result.overDurationLimit = overDurationLimit;
  }

  if (unreadable || !inline || !isInlineableImage(finalName, contentType)) return result;
  if (imagesInlined >= MAX_INLINE_IMAGES) {
    return {
      ...result,
      textFragment: `${result.tag} (not shown inline this turn — read_file to look at it) `
    };
  }

  const part = inlineImagePart(materialized.abs);
  if (!part) return result;
  return { ...result, contentParts: [part] };
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
