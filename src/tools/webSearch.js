const { SERPAPI_KEY } = require('../config/env');
const { fetchExternal } = require('../utils/fetch');

/**
 * Perform web search using SerpAPI and format results.
 * Returns answer box, knowledge graph, and organic search results.
 * @param {string} query - Search query string
 * @returns {Promise<string>} Formatted search results with links
 */
async function webSearch(query) {
  const params = new URLSearchParams({
    q: query,
    api_key: SERPAPI_KEY,
    engine: 'google',
    hl: 'it',
    gl: 'it',
    num: '8',
  });

  const res = await fetchExternal(`https://serpapi.com/search.json?${params}`, {}, 'SerpAPI (Ricerca Web)');
  if (!res.ok) {
    throw new Error(`SerpAPI error: ${res.status}`);
  }

  const data = await res.json();
  let results = '';

  if (data.answer_box) {
    results += `**Risposta rapida:** ${data.answer_box.answer || data.answer_box.snippet || ''}\n\n`;
  }

  if (data.knowledge_graph) {
    const kg = data.knowledge_graph;
    results += `**${kg.title || ''}:** ${kg.description || ''}\n\n`;
  }

  if (data.organic_results) {
    results += data.organic_results.slice(0, 6).map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.snippet || ''}\n   ${r.link}`
    ).join('\n\n');
  }

  return results || 'Nessun risultato trovato.';
}

module.exports = { webSearch };
