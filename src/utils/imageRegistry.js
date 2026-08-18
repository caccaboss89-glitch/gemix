// src/utils/imageRegistry.js
//
// Per-turn allowlist of the image URLs a structured search actually returned.
//
// The final `attachments` field accepts public file URLs, which is what makes a
// web image deliverable at all — and also what would let the model ship a URL it
// scraped out of a page it read, or wrote from memory. The registry closes that:
// entries come only from the structured SearXNG result objects plus the URLs
// the user wrote themselves, each kept
// with the page it was found on and deduplicated under a per-turn budget.
//
// Enforcement is a profile capability, not a global rule: the xAI branch gets
// its media URLs from a hosted search whose results GemiX never sees, so there
// would be nothing to register and every X image would stop being deliverable.

import { createLogger } from './logger.js';

const log = createLogger('ImageRegistry');

/** How many entries one turn may register, across all sources. */
const MAX_REGISTERED_IMAGES = 60;

/** Where a registered URL came from. */
const IMAGE_SOURCE = {
  SEARCH: 'web_image_search',
  USER: 'user_message'
};

/** https URLs as written in a user message. */
const USER_URL_RE = /https:\/\/[^\s<>"')\]]+/gi;

/** A new, empty per-turn registry. */
function createImageRegistry() {
  return { entries: new Map(), overflowed: false };
}

/**
 * Canonical form of an image URL, or null when it is not one we would ever
 * fetch: https only, a real host, no embedded credentials. The fragment is
 * dropped so the same file named twice registers once.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeImageUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Record structured search hits. Anything without a usable URL is skipped, so a
 * malformed or half-written result object cannot smuggle an entry in.
 *
 * @param {object} registry
 * @param {Array<object>} results - search hits ({ url|imageUrl, sourcePage|source_page|sourceUrl, title|caption })
 * @param {string} source - one of IMAGE_SOURCE
 * @returns {number} entries added
 */
function registerImageResults(registry, results, source) {
  if (!registry || !Array.isArray(results)) return 0;
  let added = 0;
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const url = normalizeImageUrl(result.url || result.imageUrl);
    if (!url || registry.entries.has(url)) continue;
    if (registry.entries.size >= MAX_REGISTERED_IMAGES) {
      registry.overflowed = true;
      break;
    }
    const label = result.title || result.caption;
    registry.entries.set(url, {
      url,
      source,
      sourcePage: normalizeImageUrl(result.sourcePage || result.source_page || result.sourceUrl) || null,
      label: typeof label === 'string' ? label.trim().slice(0, 120) : null
    });
    added++;
  }
  return added;
}

/**
 * Record the https URLs the user typed. They are the user's own to send, so
 * they stay deliverable under the normal attachment contract even though no
 * search produced them.
 *
 * @param {object} registry
 * @param {string} text - the current user message, quoted reply included
 * @returns {number} entries added
 */
function registerUserUrls(registry, text) {
  if (!registry || typeof text !== 'string' || !text) return 0;
  const matches = text.match(USER_URL_RE);
  if (!matches) return 0;
  return registerImageResults(registry, matches.map(url => ({ url })), IMAGE_SOURCE.USER);
}

/**
 * The registered entry for a URL, or null.
 * @param {object} registry
 * @param {string} url
 * @returns {object|null}
 */
function lookupImage(registry, url) {
  if (!registry) return null;
  const key = normalizeImageUrl(url);
  return key ? registry.entries.get(key) || null : null;
}

/**
 * Image type from the magic bytes — the real one, whatever the server declared.
 * An HTML error page hotlinked as a .jpg fails here.
 *
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string }|null}
 */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  // JPEG
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { ext: '.png', mime: 'image/png' };
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { ext: '.gif', mime: 'image/gif' };
  }
  // WEBP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  // ICO
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { ext: '.ico', mime: 'image/x-icon' };
  }
  return null;
}

/**
 * Whether a resolved download is an image at all. Both the declared type and
 * the bytes are consulted: a server lying either way still leaves an image,
 * which is what has to be registered.
 *
 * @param {object} att - resolved attachment
 * @returns {boolean}
 */
function _looksLikeImage(att) {
  if (!att) return false;
  if (typeof att.mimetype === 'string' && /^image\//i.test(att.mimetype)) return true;
  return Boolean(sniffImageType(att.buffer));
}

/**
 * Decide whether a URL the model listed may ship as an image attachment.
 *
 * Only images are gated: a PDF or a video named in the same reply goes through
 * the normal contract untouched. `finalUrl` is where the download actually
 * ended, so an entry that redirects is judged at its destination rather than
 * trusted for its starting point.
 *
 * @param {object} registry
 * @param {object} opts
 * @param {string} opts.url - the entry as the model wrote it
 * @param {string} [opts.finalUrl] - the URL the download ended on
 * @param {object} opts.att - the resolved attachment
 * @returns {{ ok: boolean, entry?: object, reason?: string }}
 */
function checkImageDelivery(registry, { url, finalUrl, att }) {
  if (!_looksLikeImage(att)) return { ok: true };

  const entry = lookupImage(registry, url);
  if (!entry) return { ok: false, reason: 'it is not among this turn\'s structured search results' };
  if (finalUrl && !normalizeImageUrl(finalUrl)) {
    return { ok: false, reason: 'the download redirected off https' };
  }
  if (!Buffer.isBuffer(att.buffer)) {
    return { ok: false, reason: 'the payload was too large to read as an image' };
  }
  if (!sniffImageType(att.buffer)) {
    return { ok: false, reason: 'the body is not a recognized image' };
  }
  if (entry.sourcePage) {
    log.info(`delivering a ${entry.source} image found on ${entry.sourcePage}`);
  }
  return { ok: true, entry };
}

export {
  MAX_REGISTERED_IMAGES,
  IMAGE_SOURCE,
  createImageRegistry,
  normalizeImageUrl,
  registerImageResults,
  registerUserUrls,
  lookupImage,
  sniffImageType,
  checkImageDelivery
};
