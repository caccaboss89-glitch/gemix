const { SERPAPI_KEY } = require('../config/env');
const { notifyAdmin } = require('../utils/adminNotifier');

async function webSearch(query) {
  const params = new URLSearchParams({
    q: query,
    api_key: SERPAPI_KEY,
    engine: 'google',
    hl: 'it',
    gl: 'it',
    num: '8',
  });

  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) {
    await notifyAdmin('SerpAPI (Ricerca Web)', `Errore HTTP ${res.status}`);
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
