// src/tools/imageSearch.js
const { SEARXNG_URL } = require('../config/env');
const { MAX_IMAGES, MAX_IMAGE_BYTES } = require('../config/constants');
const { fetchExternal, fetchWithTimeout } = require('../utils/fetch');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');

const log = createLogger('ImageSearch');

// ── Constants ──

const MAX_QUERY_LENGTH = 256;
const MAX_CANDIDATES_MULTIPLIER = 4; // fetch N×count candidates to handle failures
const MAX_CANDIDATES_CAP = 20;       // hard cap on candidates fetched from SearXNG
const PREVIEW_MAX_BYTES = 300_000;   // max base64-encoded preview size fed to vision (~300 KB)
const PREVIEW_QUALITY = 75;          // JPEG quality for resized previews (if sharp is available)
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MIN_IMAGE_BYTES = 500;         // skip suspiciously small files (tracking pixels, etc.)

// Image type → query hint injected into the search query.
// SearXNG has no native image_type API parameter, so we rely on query modification
// which works reliably across all underlying engines (Google, Bing, DuckDuckGo, etc.).
const IMAGE_TYPE_QUERY_HINTS = {
  photo: 'photograph',
  gif: 'animated gif',
  clipart: 'clipart',
  lineart: 'line drawing',
};

// ── Helpers ──

/**
 * Sanitize and trim a search query.
 * @param {string} raw
 * @returns {string}
 */
function _sanitizeQuery(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, MAX_QUERY_LENGTH);
}

/**
 * Determine file extension from MIME type.
 * @param {string} mime
 * @returns {string}
 */
function _extFromMime(mime) {
  if (!mime) return 'jpg';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return 'jpg';
}

/**
 * Try to shrink a Buffer image so it stays under PREVIEW_MAX_BYTES.
 * Uses sharp if available; falls back to raw truncation.
 * @param {Buffer} buf
 * @param {string} mime
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function _shrinkForPreview(buf, mime) {
  if (buf.length <= PREVIEW_MAX_BYTES) return { buffer: buf, mime };

  try {
    const sharp = require('sharp');
    const resized = await sharp(buf)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: PREVIEW_QUALITY })
      .toBuffer();
    return { buffer: resized, mime: 'image/jpeg' };
  } catch {
    return { buffer: buf.subarray(0, PREVIEW_MAX_BYTES), mime };
  }
}

/**
 * Download an image URL and return its Buffer + MIME type.
 * @param {string} url
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function _downloadImage(url) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'image/*,*/*;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) throw new Error(`non-image content-type: ${mime}`);

  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);

  if (buffer.length < MIN_IMAGE_BYTES) throw new Error('file too small (likely tracking pixel)');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`file too large (${Math.round(buffer.length / 1_048_576)}MB)`);

  return { buffer, mime };
}

/**
 * Search SearXNG for image candidates. Returns raw metadata list — does NOT download.
 * @param {string} query - Clean search query
 * @param {number} maxCandidates - Max candidates to collect
 * @param {string} language - SearXNG language code
 * @param {string} [imageType] - Optional image type filter
 * @returns {Promise<Array<{title: string, source_url: string, img_url: string, thumbnail_url: string|null}>>}
 */
async function _searchCandidates(query, maxCandidates, language = 'it', imageType = null) {
  // Inject image type hint into query (SearXNG has no native filter for this)
  let finalQuery = query;
  if (imageType && IMAGE_TYPE_QUERY_HINTS[imageType]) {
    finalQuery = `${query} ${IMAGE_TYPE_QUERY_HINTS[imageType]}`;
  }

  const params = new URLSearchParams({
    q: finalQuery,
    format: 'json',
    language,
    pageno: 1,
    categories: 'images',
    safesearch: 0,       // always unrestricted — not configurable
  });

  const url = `${SEARXNG_URL}/search?${params}`;
  log.info(`🖼️  Ricerca immagini: "${finalQuery}" (candidates=${maxCandidates}, type=${imageType || 'any'})`);

  const res = await fetchExternal(url, {}, 'SearXNG (Image Search)');
  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);

  const data = await res.json();
  const raw = Array.isArray(data.results) ? data.results : [];

  // Deduplicate by img_url
  const seen = new Set();
  const candidates = [];

  for (const item of raw) {
    const imgUrl = item.img_src || item.thumbnail_src || item.thumbnail || item.image_url;
    if (!imgUrl || seen.has(imgUrl)) continue;

    // For GIF type: pre-filter by URL extension to improve accuracy
    if (imageType === 'gif') {
      const urlLower = imgUrl.toLowerCase();
      if (!urlLower.endsWith('.gif') && !urlLower.includes('.gif?') && !urlLower.includes('/gif')) {
        continue;
      }
    }

    seen.add(imgUrl);

    candidates.push({
      title: (item.title || 'Image').trim(),
      source_url: item.url || item.webpage_url || imgUrl,
      img_url: imgUrl,
      thumbnail_url: item.thumbnail_src || item.thumbnail || null,
    });

    if (candidates.length >= maxCandidates) break;
  }

  return candidates;
}

/**
 * Download a candidate image and prepare it as both:
 *   - A vision preview (base64 data-URL, shrunk if needed) for the AI to inspect
 *   - A full-res attachment buffer for delivery to the user
 *
 * @param {object} candidate - { title, source_url, img_url, thumbnail_url }
 * @param {string} query - Original search query (for filename)
 * @param {number} index - 0-based index (for filename)
 * @returns {Promise<{preview: string, attachment: object, meta: object}|null>}
 */
async function _prepareImage(candidate, query, index) {
  const previewUrl = candidate.thumbnail_url || candidate.img_url;
  const fullUrl = candidate.img_url;

  // Download preview for AI vision
  let previewBuf, previewMime;
  try {
    const dl = await _downloadImage(previewUrl);
    previewBuf = dl.buffer;
    previewMime = dl.mime;
  } catch (previewErr) {
    log.debug(`   Preview download failed for "${candidate.title}": ${previewErr.message}`);
    try {
      const dl = await _downloadImage(fullUrl);
      previewBuf = dl.buffer;
      previewMime = dl.mime;
    } catch (fullErr) {
      log.warn(`   ❌ Download anteprima e completo falliti per "${candidate.title}": ${fullErr.message}`);
      return null;
    }
  }

  // Shrink preview if needed
  const { buffer: shrunkBuf, mime: shrunkMime } = await _shrinkForPreview(previewBuf, previewMime);
  const previewDataUrl = `data:${shrunkMime};base64,${shrunkBuf.toString('base64')}`;

  // Download full-res attachment (only if thumbnail was used for preview)
  let attachmentBuf = previewBuf;
  let attachmentMime = previewMime;

  if (previewUrl !== fullUrl) {
    try {
      const dl = await _downloadImage(fullUrl);
      attachmentBuf = dl.buffer;
      attachmentMime = dl.mime;
    } catch {
      attachmentBuf = previewBuf;
      attachmentMime = previewMime;
    }
  }

  const ext = _extFromMime(attachmentMime);
  const base = sanitizeFilename(query, 40) || 'image';
  const filename = `${base}_${index + 1}.${ext}`;

  return {
    preview: previewDataUrl,
    attachment: {
      name: filename,
      buffer: attachmentBuf,
      mimetype: attachmentMime,
    },
    meta: {
      title: candidate.title,
      source_url: candidate.source_url,
    },
  };
}

// ── Main export ──

/**
 * Search for images and return multimodal tool result with vision previews.
 *
 * @param {string} query - Search query
 * @param {number} [count=1] - Number of images (1-MAX_IMAGES)
 * @param {object} [options]
 * @param {string} [options.language='it'] - Language hint for SearXNG
 * @param {string} [options.image_type='any'] - Image type: 'any' | 'photo' | 'gif' | 'clipart' | 'lineart'
 * @param {number} [options._startId=1] - Starting image ID for labeling (managed by tools/index.js)
 * @returns {Promise<{toolResult: string|Array, attachments: Array}>}
 */
async function imageSearch(query, count = 1, { language = 'it', image_type = 'any', _startId = 1 } = {}) {
  // ── Validate query ──
  const q = _sanitizeQuery(query);
  if (!q) {
    return { toolResult: { success: false, error: 'Image search requires a non-empty query.' }, attachments: [] };
  }
  if (q.length < 2) {
    return { toolResult: { success: false, error: 'Query too short. Provide a more descriptive query.' }, attachments: [] };
  }

  // ── Clamp count ──
  const wantCount = Math.max(1, Math.min(MAX_IMAGES, Number(count) || 1));

  // ── Resolve image type filter ──
  const typeFilter = (image_type && image_type !== 'any') ? image_type : null;

  // For GIF searches, request more candidates (URL pre-filtering is strict)
  const candidateMultiplier = typeFilter === 'gif' ? MAX_CANDIDATES_MULTIPLIER * 2 : MAX_CANDIDATES_MULTIPLIER;

  // ── Search for candidates ──
  const maxCandidates = Math.min(wantCount * candidateMultiplier, MAX_CANDIDATES_CAP);
  let candidates;
  try {
    candidates = await _searchCandidates(q, maxCandidates, language, typeFilter);
  } catch (err) {
    log.error(`   ❌ Ricerca SearXNG fallita: ${err.message}`);
    throw new Error(`Image search engine unavailable: ${err.message}`);
  }

  if (candidates.length === 0) {
    return { toolResult: { success: false, error: `No images found for "${q}". Try a different query.` }, attachments: [] };
  }

  log.info(`   Found ${candidates.length} candidates, downloading up to ${wantCount}...`);

  // ── Download & prepare images ──
  const prepared = [];

  for (let i = 0; i < candidates.length && prepared.length < wantCount; i++) {
    const img = await _prepareImage(candidates[i], q, prepared.length);
    if (img) {
      prepared.push(img);
      log.info(`   ✅ [${prepared.length}/${wantCount}] "${candidates[i].title}"`);
    }
  }

  if (prepared.length === 0) {
    log.warn(`   ⚠️ Tutti i download falliti per "${q}"`);
    return {
      toolResult: { success: false, error: `Found results for "${q}" but all downloads failed. Try a different query.` },
      attachments: [],
    };
  }

  // ── Build multimodal tool result for AI vision ──
  // Labels use global IDs (_startId) so the AI can reference them across multiple calls.
  const contentParts = [];

  const metaLines = [
    `Found ${prepared.length} image(s) for "${q}". Review previews below. Use discard with IDs to remove unwanted results.`,
    '',
    ...prepared.map((img, i) => [
      `[Image ${_startId + i}]`,
      `  Title: ${img.meta.title}`,
      `  Source: ${img.meta.source_url}`,
    ].join('\n')),
  ];

  contentParts.push({ type: 'text', text: metaLines.join('\n') });

  for (const img of prepared) {
    contentParts.push({
      type: 'image_url',
      image_url: { url: img.preview },
    });
  }

  log.info(`   📦 ${prepared.length} immagini con preview vision (ID ${_startId}-${_startId + prepared.length - 1})`);

  return {
    toolResult: contentParts,
    attachments: prepared.map(img => img.attachment),
  };
}

module.exports = { imageSearch };