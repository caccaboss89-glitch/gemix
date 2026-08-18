// src/utils/openaiImageReferences.js
//
// Resolve the reference_images contract of the OpenAI generate_image tool.
// The private Codex Image endpoint accepts JSON `images[].image_url` entries,
// including base64 data URLs; no xAI upload or public staging is involved.
//
// Staged, not yet reachable: generate_image still refuses reference_images by
// name, because the live probe could not confirm the accepted reference count,
// sizes or mask support — the account hit its usage limit first. The wire shape
// below is the part the probe did establish (JSON accepted, multipart refused).
// See docs/deep-research/2026-08-18-gpt-image-2-and-search-sources-probe.md for
// what the re-probe has to answer before the tool schema may expose any of this.

import fs from 'fs';
import constants from '../config/constants.js';
import { resolveLocalFileEntry } from './deliverySelection.js';
import { downloadPublicFile } from './fetch.js';
import { sniffImageType } from './imageRegistry.js';

const MAX_OPENAI_REFERENCE_IMAGES = 16;
const ACCEPTED_REFERENCE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// All dimensions satisfy GPT Image 2's documented multiple-of-16, pixel-count
// and maximum 3:1 edge-ratio constraints. The backend may normalize them and
// reports the dimensions it actually produced in its response.
const OPENAI_ASPECT_SIZES = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '4:3': '1536x1152',
  '3:4': '1152x1536'
});

function openAiSizeForAspect(aspectRatio) {
  if (aspectRatio === undefined || aspectRatio === null || aspectRatio === '') return null;
  return OPENAI_ASPECT_SIZES[String(aspectRatio).trim()] || null;
}

function _validatedDataUrl(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: `Reference image "${label}" is empty.` };
  }
  if (buffer.length > constants.MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `Reference image "${label}" exceeds the ${Math.round(constants.MAX_IMAGE_BYTES / 1024 / 1024)} MB limit.`
    };
  }
  const type = sniffImageType(buffer);
  if (!type || !ACCEPTED_REFERENCE_MIMES.has(type.mime)) {
    return {
      ok: false,
      reason: `Reference image "${label}" is not a PNG, JPEG or WEBP image.`
    };
  }
  return { ok: true, image: { image_url: `data:${type.mime};base64,${buffer.toString('base64')}` } };
}

function _readLocalReference(found, label) {
  if (Buffer.isBuffer(found?.buffer)) return _validatedDataUrl(found.buffer, label);
  if (!found?.filePath) return { ok: false, reason: `Reference image "${label}" has no readable content.` };
  try {
    const stat = fs.statSync(found.filePath);
    if (!stat.isFile()) return { ok: false, reason: `Reference image "${label}" is not a regular file.` };
    if (stat.size === 0) return { ok: false, reason: `Reference image "${label}" is empty.` };
    if (stat.size > constants.MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `Reference image "${label}" exceeds the ${Math.round(constants.MAX_IMAGE_BYTES / 1024 / 1024)} MB limit.`
      };
    }
    return _validatedDataUrl(fs.readFileSync(found.filePath), label);
  } catch (error) {
    return { ok: false, reason: `Cannot read reference image "${label}": ${error.message}` };
  }
}

async function _downloadReference(url) {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, reason: 'Reference image URLs must use public HTTPS.' };
  }
  try {
    const downloaded = await downloadPublicFile(url, {
      maxBytes: constants.MAX_IMAGE_BYTES,
      timeoutMs: constants.FETCH_TIMEOUT_MS
    });
    if (!/^https:\/\//i.test(downloaded.finalUrl || '')) {
      return { ok: false, reason: 'Reference image redirected outside public HTTPS.' };
    }
    return _validatedDataUrl(downloaded.buffer, url);
  } catch (error) {
    return { ok: false, reason: `Cannot download reference image: ${error.message}` };
  }
}

/**
 * Resolve filenames from this turn/history and public HTTPS URLs into the JSON
 * data-URL array accepted by the private Codex `/images/edits` route.
 *
 * @returns {Promise<{ok:true, images:object[]}|{ok:false, reason:string}>}
 */
async function resolveOpenAiReferenceImages(referenceImages, userCtx, responseCtx) {
  const entries = Array.isArray(referenceImages) ? referenceImages : [];
  if (entries.length > MAX_OPENAI_REFERENCE_IMAGES) {
    return {
      ok: false,
      reason: `Too many reference images (${entries.length}). Max allowed: ${MAX_OPENAI_REFERENCE_IMAGES}.`
    };
  }

  const images = [];
  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'string' || !rawEntry.trim()) {
      return { ok: false, reason: 'Each reference image must be a filename or a public HTTPS URL.' };
    }
    const entry = rawEntry.trim();
    let resolved;
    if (/^https?:\/\//i.test(entry)) {
      resolved = await _downloadReference(entry);
    } else {
      const found = resolveLocalFileEntry(entry, userCtx, responseCtx);
      if (!found) {
        return {
          ok: false,
          reason: `Reference image "${entry}" was not found in the delivery buffer or chat history.`
        };
      }
      resolved = _readLocalReference(found, entry);
    }
    if (!resolved.ok) return resolved;
    images.push(resolved.image);
  }
  return { ok: true, images };
}

export {
  MAX_OPENAI_REFERENCE_IMAGES,
  OPENAI_ASPECT_SIZES,
  openAiSizeForAspect,
  resolveOpenAiReferenceImages
};
