const { SERPAPI_KEY } = require('../config/env');
const { notifyAdmin } = require('../utils/adminNotifier');

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 7_500_000;

function safeFileBaseName(text) {
  return (text || 'immagine')
    .replace(/[^a-zA-Z0-9àèéìòù\s_-]/gi, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 50) || 'immagine';
}

function extensionFromMime(mimetype) {
  if (!mimetype || typeof mimetype !== 'string') return null;
  if (mimetype.includes('jpeg')) return 'jpg';
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('webp')) return 'webp';
  if (mimetype.includes('gif')) return 'gif';
  if (mimetype.includes('bmp')) return 'bmp';
  return null;
}

async function fetchImageAsAttachment(url, query, index) {
  const res = await fetch(url, {
    headers: {
      // Helps avoid 403 from some CDNs that block non-browser user agents.
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

async function imageSearch(query, requestedCount = 2) {
  const q = (query || '').trim();
  if (!q) {
    return {
      text: 'Errore: query immagini mancante.',
      attachments: [],
    };
  }

  const count = Math.max(1, Math.min(MAX_IMAGES, Number(requestedCount) || 2));

  const params = new URLSearchParams({
    engine: 'google_images',
    q,
    api_key: SERPAPI_KEY,
    hl: 'it',
    gl: 'it',
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) {
    await notifyAdmin('SerpAPI (Ricerca Immagini)', `Errore HTTP ${res.status}`);
    throw new Error(`SerpAPI immagini error: ${res.status}`);
  }

  const data = await res.json();
  const imageResults = Array.isArray(data.images_results) ? data.images_results : [];
  if (imageResults.length === 0) {
    return {
      text: `Nessuna immagine trovata per "${q}".`,
      attachments: [],
    };
  }

  const picked = imageResults.slice(0, Math.max(count * 2, 6));
  const attachments = [];
  const sources = [];

  for (let i = 0; i < picked.length && attachments.length < count; i++) {
    const item = picked[i];
    const imgUrl = item.original || item.thumbnail;
    if (!imgUrl) continue;

    try {
      const att = await fetchImageAsAttachment(imgUrl, q, attachments.length);
      attachments.push(att);
      sources.push({
        title: item.title || `Immagine ${attachments.length}`,
        source: item.source || item.link || imgUrl,
      });
    } catch {
      // Skip broken/hotlink-protected images and continue.
    }
  }

  if (attachments.length === 0) {
    return {
      text: `Ho trovato risultati immagini per "${q}", ma non sono riuscito a scaricare file validi da allegare.`,
      attachments: [],
    };
  }

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