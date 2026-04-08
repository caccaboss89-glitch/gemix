const { SEARXNG_URL } = require('../config/env');
const { fetchExternal, fetchWithTimeout } = require('../utils/fetch');

/**
 * Perform web search using SearXNG (self-hosted) and format results.
 * Returns search results with snippets and links.
 * @param {string} query - Search query string
 * @param {number} numResults - Number of results to return (1-50, default 15)
 * @returns {Promise<string>} Formatted search results with links
 */
async function webSearch(query, numResults = 15) {
  // Validate and clamp numResults to 1-50 range
  const validNumResults = Math.max(1, Math.min(50, parseInt(numResults) || 15));

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: 'it',
    pageno: 1,
  });

  const url = `${SEARXNG_URL}/search?${params}`;

  const res = await fetchExternal(url, {}, 'SearXNG (Ricerca Web Locale)');
  if (!res.ok) {
    throw new Error(`SearXNG error: ${res.status}`);
  }

  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return 'Nessun risultato trovato.';
  }

  const results = data.results.slice(0, validNumResults).map((r, i) =>
    `${i + 1}. **${r.title}**\n   ${r.content || ''}\n   ${r.url}`
  ).join('\n\n');

  return results;
}

const MAX_WEBPAGE_CHARS = 10000;

/**
 * Fetch a web page and extract its text content.
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Extracted text content
 */
async function fetchWebpage(url) {
  if (!url || typeof url !== 'string') {
    return 'Errore: URL mancante o non valido.';
  }

  try {
    new URL(url);
  } catch {
    return 'Errore: URL non valido.';
  }

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const html = await res.text();

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > MAX_WEBPAGE_CHARS) {
    text = text.substring(0, MAX_WEBPAGE_CHARS) + '... (contenuto troncato)';
  }

  return text || 'Nessun contenuto testuale trovato nella pagina.';
}

module.exports = { webSearch, fetchWebpage };