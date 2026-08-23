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

/** True when this path is an image worth attaching inline. */
function isInlineImageExt(filePath) {
  return INLINE_IMAGE_EXTS.has(path.extname(String(filePath || '')).toLowerCase());
}

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
    const base64 = fs.readFileSync(absPath).toString('base64');
    return { type: 'input_image', image_url: `data:${mime};base64,${base64}` };
  } catch {
    return null;
  }
}

export { INLINE_IMAGE_EXTS, isInlineImageExt, inlineImagePart };
