// src/utils/openaiFileProjection.js
//
// Turns a local file into the content part GPT-5.6 Sol receives.
//
// The OpenAI profile has no upload step: it never calls xAI auth, tmpfile.link,
// the stale-URL refresh or any other remote staging service. Everything the
// model reads travels inline in the request body as base64, which is why the
// matrix in config/openaiFileMatrix.js caps sizes lower than the backend alone
// would accept.
//
// A file that does not pass the matrix is not an error: it stays in the chat
// history exactly as before and the caller turns the returned note into an
// attachment tag, so the model knows the file exists and why it cannot read it.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { mimeForExtension, mimeBase } from '../config/mimeExtensions.js';
import {
  OPENAI_PROJECTION,
  SNIFF_BYTES,
  classifyForOpenAi,
  skipNoteFor
} from '../config/openaiFileMatrix.js';
import { createLogger } from './logger.js';

const log = createLogger('OpenAiFiles');

/** Same per-call ceiling the xAI branch applies to re-attached history images. */
const MAX_IMAGE_READS = constants.MAX_HISTORY_MEDIA_IMAGES;

/**
 * Read the bytes the matrix needs to identify a file: the head is enough for
 * every format except GIF, whose frame count only shows in the full file.
 * @returns {Buffer}
 */
function _sniff(absPath, sizeBytes, ext) {
  const wanted = ext === '.gif' ? sizeBytes : Math.min(sizeBytes, SNIFF_BYTES);
  if (wanted >= sizeBytes) return fs.readFileSync(absPath);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(wanted);
    const read = fs.readSync(fd, buf, 0, wanted, 0);
    return read === wanted ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Build the inline content part for an accepted file. */
function _inlinePart(projection, buffer, filename, mimetype) {
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;
  return projection === OPENAI_PROJECTION.IMAGE
    ? { type: 'input_image', image_url: dataUrl }
    : { type: 'input_file', filename, file_data: dataUrl };
}

/**
 * Project a file on disk.
 *
 * @param {string} absPath
 * @param {string} displayPath - name shown to the model
 * @param {object} [opts]
 * @param {string} [opts.mimetype]
 * @param {number} [opts.imagesReadCount] - images already attached this call
 * @returns {{ success: true, parts: object[], bumpImageCount?: boolean }
 *   | { success: false, error: string, note: string }}
 */
function projectFileForOpenAi(absPath, displayPath, opts = {}) {
  const name = path.basename(displayPath || absPath || 'file');
  const ext = path.extname(name).toLowerCase();
  const mimetype = mimeBase(opts.mimetype || '') || mimeForExtension(ext, 'application/octet-stream');

  let sizeBytes;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error('not a regular file');
    sizeBytes = stat.size;
  } catch (err) {
    return { success: false, error: `Cannot read file "${displayPath}": ${err.message}`, note: 'file unavailable' };
  }

  let head;
  try {
    head = _sniff(absPath, sizeBytes, ext);
  } catch (err) {
    return { success: false, error: `Cannot inspect "${displayPath}": ${err.message}`, note: 'file unreadable' };
  }

  const verdict = classifyForOpenAi({ name, mimetype, sizeBytes, head });
  if (verdict.as === OPENAI_PROJECTION.SKIP) {
    const note = skipNoteFor(verdict.reason, verdict.detail);
    return { success: false, error: `"${displayPath}" is not readable by this model (${note}).`, note };
  }

  if (verdict.as === OPENAI_PROJECTION.IMAGE && (opts.imagesReadCount ?? 0) >= MAX_IMAGE_READS) {
    return {
      success: false,
      error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.`,
      note: 'image limit reached'
    };
  }

  let buffer;
  try {
    buffer = head.length === sizeBytes ? head : fs.readFileSync(absPath);
  } catch (err) {
    return { success: false, error: `Cannot read "${displayPath}": ${err.message}`, note: 'file unreadable' };
  }

  const part = _inlinePart(verdict.as, buffer, name, mimetype);
  part._sourcePath = absPath;
  return {
    success: true,
    parts: [{ type: 'text', text: `[Attachment: ${displayPath}]` }, part],
    bumpImageCount: verdict.as === OPENAI_PROJECTION.IMAGE
  };
}

/**
 * Project an in-memory buffer — a file GemiX just produced (formal PDF, search
 * hit, generated image) that the model should see without a temp file.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimetype
 * @returns {object|null} the content part, or null when the matrix refuses it
 */
function projectBufferForOpenAi(buffer, filename, mimetype) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const name = path.basename(filename || 'file');
  const ext = path.extname(name).toLowerCase();
  const mime = mimeBase(mimetype || '') || mimeForExtension(ext, 'application/octet-stream');

  const verdict = classifyForOpenAi({ name, mimetype: mime, sizeBytes: buffer.length, head: buffer });
  if (verdict.as === OPENAI_PROJECTION.SKIP) {
    log.warn(`Generated file "${name}" not shown to the model: ${skipNoteFor(verdict.reason, verdict.detail)}`);
    return null;
  }
  return _inlinePart(verdict.as, buffer, name, mime);
}

export {
  projectFileForOpenAi,
  projectBufferForOpenAi
};
