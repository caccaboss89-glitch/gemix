// src/tools/workspace/inlineImage.js
//
// Turning a local image into a content part the model can actually look at.
//
// The part is an inline base64 data URL. It is not an upload: no user file is
// published to a third-party host on the way to the model (spec §17.23), so
// there is no public link to leak and nothing to expire mid-turn.

import fs from 'fs';
import path from 'path';
import constants from '../../config/constants.js';
import { mimeForExtension } from '../../config/mimeExtensions.js';

/** Formats a vision model reads directly. */
const INLINE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/**
 * Build an `input_image` part from a file on disk.
 *
 * @param {string} absPath
 * @param {number} [maxBytes]
 * @returns {{ type: 'input_image', image_url: string }|null} null when the file
 *   is missing, unreadable, or too large to inline.
 */
function inlineImagePart(absPath, maxBytes = constants.MAX_IMAGE_BYTES) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
    const mime = mimeForExtension(path.extname(absPath), 'image/png');
    return inlineImagePartFromBuffer(fs.readFileSync(absPath), mime, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Same part, from bytes already in memory. Used where the image never needs to
 * touch disk, such as a search hit downloaded only to be looked at.
 *
 * @param {Buffer} buffer
 * @param {string} mime
 * @param {number} [maxBytes]
 * @returns {{ type: 'input_image', image_url: string }|null}
 */
function inlineImagePartFromBuffer(buffer, mime, maxBytes = constants.MAX_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxBytes) return null;
  return { type: 'input_image', image_url: `data:${mime || 'image/png'};base64,${buffer.toString('base64')}` };
}

export { INLINE_IMAGE_EXTS, inlineImagePart, inlineImagePartFromBuffer };
