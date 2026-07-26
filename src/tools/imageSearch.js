// src/tools/imageSearch.js
//
// Local web image search via a self-hosted SearXNG instance (JSON API).
// Returns direct https image file URLs for delivery through final `attachments`,
// and attaches each found image as native vision content (input_image) so the
// model can see them — same multimodal tool-result pattern as read_sent_messages.
// Config: IMAGE_SEARCH_BASE_URL (default http://127.0.0.1:8888).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IMAGE_SEARCH_BASE_URL } = require('../config/env');
const { MAX_IMAGE_BYTES } = require('../config/constants');
const { fetchWithTimeout, downloadPublicFile } = require('../utils/fetch');
const { buildXaiFileParts } = require('../utils/aiFileDelivery');
const { TEMP_DIR } = require('../utils/tempFileServer');
const { createLogger } = require('../utils/logger');

const log = createLogger('ImageSearch');

const DEFAULT_COUNT = 2;
const MIN_COUNT = 1;
const MAX_COUNT = 10;
const SEARCH_TIMEOUT_MS = 25_000;
const VISION_DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_QUERY_LEN = 300;

/**
 * Normalize and cap the user/model query.
 * @param {unknown} raw
 * @returns {string}
 */
function _cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

/**
 * Clamp requested result count.
 * @param {unknown} raw
 * @returns {number}
 */
function _clampCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.floor(n)));
}

/**
 * True when a string looks like a direct https image URL we can hand to delivery.
 * @param {unknown} u
 * @returns {boolean}
 */
function _isHttpsImageUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!/^https:\/\//i.test(s)) return false;
  // Reject obvious HTML pages / data URIs / relative paths.
  if (/^https?:\/\/[^/]+\/?$/i.test(s)) return false;
  if (/\.(html?|php|aspx?)(\?|#|$)/i.test(s)) return false;
  return true;
}

/**
 * Prefer img_src (direct file), then thumbnail_src as last resort.
 * @param {object} hit
 * @returns {string|null}
 */
function _pickImageUrl(hit) {
  if (!hit || typeof hit !== 'object') return null;
  for (const key of ['img_src', 'thumbnail_src', 'thumbnail']) {
    const candidate = hit[key];
    if (_isHttpsImageUrl(candidate)) return String(candidate).trim();
  }
  // Some engines put the image file in `url` when category is images.
  if (_isHttpsImageUrl(hit.url) && /\.(jpe?g|png|gif|webp|bmp|avif)(\?|#|$)/i.test(hit.url)) {
    return String(hit.url).trim();
  }
  return null;
}

/**
 * Detect image type from magic bytes. Rejects HTML/error bodies hotlinked as images.
 * @param {Buffer} buffer
 * @returns {{ ext: string, mime: string }|null}
 */
function _sniffImageType(buffer) {
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
 * Download one search hit and build a native input_image part for the model.
 * @returns {Promise<{ part: object|null, error?: string }>}
 */
async function _buildVisionPart(imgUrl, index) {
  let destPath = null;
  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const dl = await downloadPublicFile(imgUrl, {
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: VISION_DOWNLOAD_TIMEOUT_MS,
    });
    const sniffed = _sniffImageType(dl.buffer);
    if (!sniffed) {
      return { part: null, error: 'Downloaded body is not a recognized image (JPEG/PNG/WEBP/GIF/ICO).' };
    }
    const name = `search_img_${index}${sniffed.ext}`;
    destPath = path.join(
      TEMP_DIR,
      `imgsearch_${crypto.randomBytes(8).toString('hex')}_${name}`,
    );
    fs.writeFileSync(destPath, dl.buffer);

    const built = await buildXaiFileParts(destPath, name, {
      mimetype: sniffed.mime,
      imagesReadCount: index,
    });
    if (!built.success) {
      return { part: null, error: built.error || 'vision upload failed' };
    }
    // Prefer true vision parts; gif/unsupported still may arrive as input_file.
    const part = built.parts.find(p => p.type === 'input_image')
      || built.parts.find(p => p.type === 'input_file')
      || null;
    return { part };
  } catch (err) {
    log.warn(`Vision preview failed for image ${index}: ${err.message}`);
    return { part: null, error: err.message };
  } finally {
    if (destPath) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Search the web for images via local SearXNG.
 * On success with hits, returns multimodal content parts (text JSON + vision).
 * On error / empty, returns a plain result object.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {number} [args.count]
 * @returns {Promise<object|Array>}
 */
async function searchImages(args = {}) {
  const query = _cleanQuery(args.query);
  if (!query) {
    return { success: false, error: 'Missing required argument "query".' };
  }

  const count = _clampCount(args.count);
  const base = String(IMAGE_SEARCH_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      success: false,
      error: 'Image search is not configured (IMAGE_SEARCH_BASE_URL is invalid).',
    };
  }

  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'images');
  // Prefer Google Images when the local instance has it active; others fill gaps.
  url.searchParams.set('engines', 'google images,bing images,duckduckgo images');
  url.searchParams.set('pageno', '1');
  url.searchParams.set('safesearch', '0');

  let data;
  try {
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GemiX-ImageSearch/1.0',
      },
    }, SEARCH_TIMEOUT_MS);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`SearXNG HTTP ${res.status}: ${body.slice(0, 200)}`);
      if (res.status === 403) {
        return {
          success: false,
          error:
            'Image search service rejected JSON format (enable "json" under search.formats in SearXNG settings.yml).',
        };
      }
      return {
        success: false,
        error: `Image search service returned HTTP ${res.status}. Is SearXNG running at ${base}?`,
      };
    }

    try {
      data = await res.json();
    } catch (parseErr) {
      log.warn(`SearXNG invalid JSON: ${parseErr.message}`);
      return {
        success: false,
        error: 'Image search service returned invalid JSON. Check SearXNG logs and that format=json is enabled.',
      };
    }
  } catch (err) {
    log.warn(`SearXNG request failed: ${err.message}`);
    return {
      success: false,
      error:
        `Image search service unreachable at ${base}: ${err.message}. `
        + 'Ensure the local SearXNG container is running (see image-search/ docker-compose).',
    };
  }

  const rawResults = Array.isArray(data?.results) ? data.results : [];
  const seen = new Set();
  const images = [];

  for (const hit of rawResults) {
    const imgUrl = _pickImageUrl(hit);
    if (!imgUrl || seen.has(imgUrl)) continue;
    seen.add(imgUrl);
    images.push({
      url: imgUrl,
      title: typeof hit.title === 'string' ? hit.title.trim().slice(0, 200) : '',
      source_page: typeof hit.url === 'string' && hit.url !== imgUrl ? hit.url : undefined,
      engine: typeof hit.engine === 'string' ? hit.engine : undefined,
    });
    if (images.length >= count) break;
  }

  if (images.length === 0) {
    return {
      success: true,
      query,
      count: 0,
      images: [],
      message:
        'No direct image URLs found for this query. Try a different query; do not invent URLs.',
    };
  }

  // Build vision previews in parallel (download + re-host for xAI).
  const visionSettled = await Promise.all(
    images.map((img, i) => _buildVisionPart(img.url, i)),
  );

  const nativeParts = [];
  const imagesOut = images.map((img, i) => {
    const v = visionSettled[i];
    const entry = {
      index: i,
      url: img.url,
      title: img.title,
      vision: Boolean(v && v.part),
    };
    if (img.source_page) entry.source_page = img.source_page;
    if (img.engine) entry.engine = img.engine;
    if (v && v.part) {
      nativeParts.push(
        { type: 'text', text: `[search_images IMAGE_${i}]` },
        v.part,
      );
    } else if (v && v.error) {
      entry.vision_error = String(v.error).slice(0, 160);
    }
    return entry;
  });

  const visionCount = imagesOut.filter(x => x.vision).length;
  const payload = {
    success: true,
    query,
    count: imagesOut.length,
    vision_count: visionCount,
    images: imagesOut,
    message:
      visionCount > 0
        ? `Found ${imagesOut.length} image(s); ${visionCount} attached as vision previews labeled IMAGE_0…IMAGE_n. `
          + 'Inspect them visually, then put the chosen image `url` value(s) in final `attachments`. '
          + 'Only use these URLs — never invent ones or use render/citation component syntax.'
        : `Found ${imagesOut.length} image URL(s) but none could be loaded for vision. `
          + 'You may still put a `url` from the list in final `attachments` if appropriate, or retry with another query. '
          + 'Never invent URLs or use render/citation component syntax.',
  };

  if (nativeParts.length === 0) {
    return payload;
  }
  return [{ type: 'text', text: JSON.stringify(payload) }, ...nativeParts];
}

module.exports = {
  searchImages,
  DEFAULT_COUNT,
  MIN_COUNT,
  MAX_COUNT,
  _cleanQuery,
  _clampCount,
  _pickImageUrl,
};
