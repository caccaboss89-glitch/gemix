const { SEARXNG_URL } = require('../config/env');
const { fetchExternal } = require('../utils/fetch');

/**
 * Perform web search using SearXNG (self-hosted) and format results.
 * Returns search results with snippets and links.
 * @param {string} query - Search query string
 * @returns {Promise<string>} Formatted search results with links
 */
async function webSearch(query) {
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

  const results = data.results.slice(0, 30).map((r, i) =>
    `${i + 1}. **${r.title}**\n   ${r.content || ''}\n   ${r.url}`
  ).join('\n\n');

  return results;
}

module.exports = { webSearch };