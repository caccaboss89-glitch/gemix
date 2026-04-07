const { SEARXNG_URL } = require('../config/env');
const { MAX_IMAGES, MAX_IMAGE_BYTES } = require('../config/constants');
const { fetchExternal, fetchWithTimeout } = require('../utils/fetch');
const { sanitizeFilename } = require('../utils/text');

/**
 * Generate safe filename from search query.
 * @param {string} text - The search query or base text
 * @returns {string} Sanitized filename (max 50 chars)
 */
function safeFileBaseName(text) {
  return sanitizeFilename(text, 50) || 'immagine';
}

/**
 * Determine file extension from MIME type.
 * @param {string} mimetype - MIME type string (e.g., 'image/jpeg')
 * @returns {string|null} File extension or null if not recognized
 */
function extensionFromMime(mimetype) {
  if (!mimetype || typeof mimetype !== 'string') return null;
  if (mimetype.includes('jpeg')) return 'jpg';
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('webp')) return 'webp';
  if (mimetype.includes('gif')) return 'gif';
  if (mimetype.includes('bmp')) return 'bmp';
  return null;
}

/**
 * Fetch image from URL and convert to attachment buffer.
 * @param {string} url - Image URL to fetch
 * @param {string} query - Original search query for filename
 * @param {number} index - Index number for filename
 * @returns {Promise<object>} Attachment object { name, buffer, mimetype }
 */
async function fetchImageAsAttachment(url, query, index) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    throw new Error('content-type non immagine');
  }

  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);
  if (buffer.length === 0) {
    throw new Error('contenuto vuoto');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`immagine troppo grande (${Math.round(buffer.length / 1024 / 1024)} MB)`);
  }

  const ext = extensionFromMime(contentType) || 'jpg';
  const base = safeFileBaseName(query);
  const name = `${base}_${index + 1}.${ext}`;

  return {
    name,
    buffer,
    mimetype: contentType,
  };
}

/**
 * Search for images using SearXNG (self-hosted, free) and download as attachments.
 * @param {string} query - Search query for images
 * @param {number} [requestedCount=1] - Number of images to fetch (1-4)
 * @returns {Promise<object>} Result object { text, attachments }
 */
async function imageSearch(query, requestedCount = 1) {
  const { createLogger } = require('../utils/logger');
  const log = createLogger('ImageSearch');
  
  const q = (query || '').trim();
  if (!q) {
    return {
      text: 'Errore: query immagini mancante.',
      attachments: [],
    };
  }

  const count = Math.max(1, Math.min(MAX_IMAGES, Number(requestedCount) || 1));

  const params = new URLSearchParams({
    q,
    format: 'json',
    language: 'it',
    pageno: 1,
    categories: 'images',
  });

  const url = `${SEARXNG_URL}/search?${params}`;
  
  log.info(`🖼️ Ricerca immagini SearXNG: "${q}" (count=${count})`);

  const res = await fetchExternal(url, {}, 'SearXNG (Ricerca Immagini Locale)');
  if (!res.ok) {
    throw new Error(`SearXNG immagini error: ${res.status}`);
  }

  const data = await res.json();
  const imageResults = Array.isArray(data.results) ? data.results : [];
  
  if (imageResults.length === 0) {
    return {
      text: `Nessuna immagine trovata per "${q}".`,
      attachments: [],
    };
  }

  const picked = imageResults.slice(0, Math.max(count * 3, 10));
  const attachments = [];
  const sources = [];

  for (let i = 0; i < picked.length && attachments.length < count; i++) {
    const item = picked[i];
    // SearXNG image results: try all known field names
    let imgUrl = item.img_src || item.thumbnail_src || item.thumbnail || item.image_url;
    
    if (!imgUrl) continue;

    try {
      const att = await fetchImageAsAttachment(imgUrl, q, attachments.length);
      attachments.push(att);
      sources.push({
        title: item.title || `Immagine ${attachments.length}`,
        source: item.url || imgUrl,
      });
    } catch (err) {
      log.warn(`   ❌ Download fallito (${err.message}), provo prossima...`);
    }
  }

  if (attachments.length === 0) {
    log.warn(`   ⚠️ Nessuna immagine scaricata per "${q}"`);
    return {
      text: `Ho trovato risultati immagini per "${q}", ma non sono riuscito a scaricare file validi da allegare.`,
      attachments: [],
    };
  }

  log.info(`   ✅ ${attachments.length} immagine/i scaricate`);
  
  const lines = [
    `Ho trovato ${attachments.length} immagine/i per "${q}" e le invio in allegato.`,
    '',
    'Fonti:',
    ...sources.map((s, i) => `${i + 1}. ${s.title}\n   ${s.source}`),
  ];

  return {
    text: lines.join('\n'),
    attachments,
  };
}

module.exports = { imageSearch };