// src/tools/searchImage.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Local web image search via a self-hosted SearXNG instance (JSON API).
// Each hit is downloaded once: the bytes are attached inline as vision content
// (input_image) so the model can see them — same multimodal tool-result pattern
// as read_sent_messages — and staged in `workspace/`, so the image the model
// picks is sent by its path like every other file.
// Config: envConfig.SEARCH_IMAGE_BASE_URL (default http://127.0.0.1:8888).

import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { fetchWithTimeout, downloadPublicFile  } from '../utils/fetch.js';
import { inlineImagePartFromBuffer  } from './workspace/inlineImage.js';
import { stageToolOutput  } from './workspace/toolOutput.js';
import { createLogger  } from '../utils/logger.js';
import { sniffImageType } from '../utils/imageType.js';
import { normalizeHttpBaseUrl } from '../utils/httpUrl.js';

const log = createLogger('SearchImage');

const {
  SEARCH_IMAGE_DEFAULT_COUNT,
  SEARCH_IMAGE_MIN_COUNT,
  SEARCH_IMAGE_MAX_COUNT,
  SEARCH_IMAGE_QUERY_MAX_CHARS
} = constants;
const SEARCH_TIMEOUT_MS = 25_000;
const VISION_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Normalize and cap the user/model query.
 * @param {unknown} raw
 * @returns {string}
 */
function _cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw

    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_IMAGE_QUERY_MAX_CHARS);
}

/**
 * Clamp requested result count.
 * @param {unknown} raw
 * @returns {number}
 */
function _clampCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SEARCH_IMAGE_DEFAULT_COUNT;
  return Math.min(SEARCH_IMAGE_MAX_COUNT, Math.max(SEARCH_IMAGE_MIN_COUNT, Math.floor(n)));
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
 * Return distinct candidate image URLs in download preference order.
 * @param {object} hit
 * @returns {string[]}
 */
function _imageUrlCandidates(hit) {
  if (!hit || typeof hit !== 'object') return [];
  const candidates = [];
  for (const key of ['img_src', 'thumbnail_src', 'thumbnail']) {
    const candidate = hit[key];
    if (_isHttpsImageUrl(candidate)) candidates.push(String(candidate).trim());
  }
  // Some engines put the image file in `url` when category is images.
  if (_isHttpsImageUrl(hit.url) && /\.(jpe?g|png|gif|webp|bmp|avif)(\?|#|$)/i.test(hit.url)) {
    candidates.push(String(hit.url).trim());
  }
  return [...new Set(candidates)].slice(0, 3);
}

/**
 * Download one search hit and build an inline input_image part for the model,
 * keeping the bytes so the caller can stage them in the workspace.
 * @returns {Promise<{ part: object|null, url?: string, buffer?: Buffer, ext?: string, error?: string }>}
 */
async function _buildVisionPart(imageUrls, index, signal) {
  let lastError = 'No usable image URL was returned.';
  for (const imgUrl of imageUrls) {
    signal?.throwIfAborted();
    try {
      const dl = await downloadPublicFile(imgUrl, {
        maxBytes: constants.MAX_IMAGE_BYTES,
        timeoutMs: VISION_DOWNLOAD_TIMEOUT_MS,
        signal
      });
      signal?.throwIfAborted();
      const sniffed = sniffImageType(dl.buffer);
      if (!sniffed) {
        lastError = 'Downloaded body is not a recognized image (JPEG/PNG/WEBP/GIF/ICO).';
        continue;
      }
      const part = inlineImagePartFromBuffer(dl.buffer, sniffed.mime);
      if (part) return { part, url: imgUrl, buffer: dl.buffer, ext: sniffed.ext };
      lastError = 'Image is too large to attach inline.';
    } catch (err) {
      if (signal?.aborted) throw signal.reason || err;
      lastError = err.message;
    }
  }
  log.warn(`Vision preview failed for image ${index}: ${lastError}`);
  return { part: null, error: lastError };
}

/**
 * Put one downloaded hit in the workspace so it can be sent by path.
 * A staging failure only costs that image its path: the vision preview and the
 * rest of the result stand.
 * @returns {Promise<string|null>} the namespace path, or null when not staged
 */
async function _stageImage(workspaceId, index, vision, signal) {
  if (!workspaceId || !vision?.buffer) return null;
  signal?.throwIfAborted();
  try {
    const staged = await stageToolOutput(workspaceId, `search_image_${index}.${vision.ext}`, vision.buffer);
    return staged.display;
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    log.warn(`Cannot stage image ${index} in the workspace: ${err.message}`);
    return null;
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
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string|null} [opts.workspaceId] - where the found images are staged
 * @returns {Promise<object|Array>}
 */
async function searchImage(args = {}, opts = {}) {
  const query = _cleanQuery(args.query);
  if (!query) {
    return { success: false, status: 'failed', error: 'Missing required argument "query".' };
  }

  const count = _clampCount(args.count);
  const base = normalizeHttpBaseUrl(envConfig.SEARCH_IMAGE_BASE_URL);
  if (!base) {
    return {
      success: false,
      status: 'failed',
      error: 'Image search is not configured (SEARCH_IMAGE_BASE_URL is invalid).'
    };
  }

  const url = new URL('/search', `${base}/`);
  // SearXNG's documented multi-engine selector is bang syntax. Its `engines`
  // query parameter is not part of the public Search API and was ignored,
  // allowing unrelated fallback engines to leak icons into image results.
  url.searchParams.set('q', `!goi !bii !ddi ${query}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'images');
  url.searchParams.set('pageno', '1');
  url.searchParams.set('safesearch', '0');

  let data;
  try {
    const res = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      signal: opts.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GemiX-ImageSearch/1.0'
      }
    }, SEARCH_TIMEOUT_MS);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`SearXNG HTTP ${res.status}: ${body.slice(0, 200)}`);
      if (res.status === 403) {
        return {
          success: false,
          status: 'failed',
          error:
            'Image search service rejected JSON format (enable "json" under search.formats in SearXNG settings.yml).'
        };
      }
      return {
        success: false,
        status: 'failed',
        error: `Image search service returned HTTP ${res.status}. Is SearXNG running at ${base}?`
      };
    }

    try {
      data = await res.json();
    } catch (parseErr) {
      log.warn(`SearXNG invalid JSON: ${parseErr.message}`);
      return {
        success: false,
        status: 'failed',
        error: 'Image search service returned invalid JSON. Check SearXNG logs and that format=json is enabled.'
      };
    }
  } catch (err) {
    if (opts.signal?.aborted) throw opts.signal.reason || err;
    log.warn(`SearXNG request failed: ${err.message}`);
    return {
      success: false,
      status: 'failed',
      error:
        `Image search service unreachable at ${base}: ${err.message}. `
        + 'Ensure the local SearXNG container (gemix-searxng) is running.'
    };
  }

  const rawResults = Array.isArray(data?.results) ? data.results : [];
  const seen = new Set();
  const images = [];

  for (const hit of rawResults) {
    const candidates = _imageUrlCandidates(hit);
    const freshCandidates = candidates.filter(candidate => !seen.has(candidate));
    const imgUrl = freshCandidates[0];
    if (!imgUrl) continue;
    seen.add(imgUrl);
    images.push({
      url: imgUrl,
      candidates: freshCandidates,
      title: typeof hit.title === 'string' ? hit.title.trim().slice(0, 200) : '',
      source_page: typeof hit.url === 'string' && hit.url !== imgUrl ? hit.url : undefined,
      engine: typeof hit.engine === 'string' ? hit.engine : undefined
    });
    if (images.length >= count) break;
  }

  if (images.length === 0) {
    const unresponsiveEngines = Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : [];
    return {
      success: true,
      status: unresponsiveEngines.length > 0 ? 'degraded' : 'ok',
      query,
      count: 0,
      images: [],
      ...(unresponsiveEngines.length > 0 ? { diagnostics: { unresponsive_engines: unresponsiveEngines } } : {}),
      message: 'No images found for this query. Try a different query.'
    };
  }

  // Build provider-neutral inline vision previews in parallel.
  const visionSettled = await Promise.all(
    images.map((img, i) => _buildVisionPart(img.candidates, i, opts.signal))
  );
  opts.signal?.throwIfAborted();

  // Sequential staging: the workspace lock serializes these writes anyway.
  const stagedPaths = [];
  for (let i = 0; i < images.length; i++) {
    opts.signal?.throwIfAborted();
    stagedPaths.push(await _stageImage(opts.workspaceId, i, visionSettled[i], opts.signal));
  }

  const nativeParts = [];
  const imagesOut = images.map((img, i) => {
    const v = visionSettled[i];
    const entry = {
      index: i,
      source_url: v?.url || img.url,
      title: img.title,
      vision: Boolean(v && v.part)
    };
    if (stagedPaths[i]) entry.path = stagedPaths[i];
    if (img.source_page) entry.source_page = img.source_page;
    if (img.engine) entry.engine = img.engine;
    if (v && v.part) {
      nativeParts.push(
        { type: 'input_text', text: `[search_image IMAGE_${i}]` },
        v.part
      );
    } else if (v && v.error) {
      entry.vision_error = String(v.error).slice(0, 160);
    }
    return entry;
  });

  const visionCount = imagesOut.filter(x => x.vision).length;
  const sendableCount = imagesOut.filter(x => x.path).length;
  const unresponsiveEngines = Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : [];
  const payload = {
    success: true,
    status: visionCount === imagesOut.length && sendableCount === imagesOut.length && unresponsiveEngines.length === 0
      ? 'ok'
      : 'degraded',
    query,
    count: imagesOut.length,
    vision_count: visionCount,
    images: imagesOut,
    ...(unresponsiveEngines.length > 0 ? { diagnostics: { unresponsive_engines: unresponsiveEngines } } : {}),
    message:
      sendableCount > 0
        ? `Found ${imagesOut.length} image(s); ${visionCount} attached as vision previews labeled IMAGE_0…IMAGE_n, `
          + `${sendableCount} saved in the workspace. Inspect them visually, then send the one you picked by putting `
          + 'its `path` in final `attachments`. An entry without a `path` was not saved and cannot be sent; '
          + '`source_url` is where it came from, not something you can attach.'
        : `Found ${imagesOut.length} image(s) but none could be downloaded, so none can be sent. `
          + 'Retry with another query.'
  };

  if (nativeParts.length === 0) {
    return payload;
  }
  return [{ type: 'input_text', text: JSON.stringify(payload) }, ...nativeParts];
}

export {
  _imageUrlCandidates,
  searchImage
};
