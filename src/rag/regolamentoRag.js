const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config/constants');
const { API_KEY, API_BASE_URL, EMBEDDING_MODEL } = require('../config/env');
const { createLogger } = require('../utils/logger');

const log = createLogger('RAG');

const REGOLAMENTO_PATH = path.join(DATA_DIR, 'regolamento.txt');
const RAG_INDEX_PATH = path.join(DATA_DIR, 'regolamento_rag.json');

let ragData = null;

/**
 * Parse regolamento.txt into articles.
 */
function parseArticles(content) {
  const articles = [];
  const lines = content.split('\n');
  let currentId = '';
  let currentTitle = '';
  let currentText = '';
  let articlesFound = 0;

  for (const line of lines) {
    const artMatch = line.match(/^ART\.\s*(\d+)\s*-\s*(.+)/);
    if (artMatch) {
      if (currentId) {
        articles.push({ id: currentId, title: currentTitle, text: currentText.trim() });
      }
      currentId = `ART. ${artMatch[1]}`;
      currentTitle = artMatch[2].trim();
      currentText = line + '\n';
      articlesFound++;
    } else if (currentId) {
      currentText += line + '\n';
    } else if (line.trim()) {
      currentId = 'PREAMBOLO';
      currentTitle = line.trim();
      currentText = line + '\n';
    }
  }
  if (currentId) {
    articles.push({ id: currentId, title: currentTitle, text: currentText.trim() });
  }
  return articles;
}

/**
 * Call the embedding API to generate vectors for an array of texts.
 * @param {string[]} texts
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function fetchEmbeddings(texts) {
  const res = await fetch(`${API_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Embedding API HTTP ${res.status}: ${errBody.substring(0, 300)}`);
  }

  const json = await res.json();
  // Sort by index to guarantee order matches input
  return json.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

/**
 * Cosine similarity between two embedding vectors.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Initialize RAG: parse regolamento, generate/load embeddings.
 */
async function initRegolamentoRag() {
  try {
    if (!fs.existsSync(REGOLAMENTO_PATH)) {
      log.warn('⚠️ regolamento.txt non trovato, RAG non inizializzato');
      return;
    }

    const content = fs.readFileSync(REGOLAMENTO_PATH, 'utf-8');
    const currentHash = crypto.createHash('sha256').update(content).digest('hex');

    let needsRebuild = true;
    if (fs.existsSync(RAG_INDEX_PATH)) {
      try {
        const cached = JSON.parse(fs.readFileSync(RAG_INDEX_PATH, 'utf-8'));
        if (cached.hash === currentHash && cached.articles && cached.embeddings) {
          ragData = cached;
          needsRebuild = false;
          log.info(`✅ RAG caricato da cache (${cached.articles.length} articoli)`);
        }
      } catch { }
    }

    if (needsRebuild) {
      log.info('🔄 Rigenerazione embeddings regolamento...');
      const articles = parseArticles(content);
      log.info(`📄 Articoli parsati: ${articles.length}`);
      
      // Filter out articles with very short or empty texts (API requires minimum text length)
      const validArticles = articles.filter(a => a.text.trim().length >= 50);
      if (validArticles.length === 0) {
        log.warn('⚠️ Nessun articolo valido trovato nel regolamento (tutti i testi sono troppo corti)');
        return;
      }
      
      log.info(`✅ ${articles.length - validArticles.length} articoli scartati (testo insufficiente)`);
      const texts = validArticles.map(a => a.text);
      log.info(`📝 Generando embeddings per ${texts.length} articoli...`);
      const embeddings = await fetchEmbeddings(texts);

      ragData = { hash: currentHash, articles: validArticles, embeddings };
      fs.writeFileSync(RAG_INDEX_PATH, JSON.stringify(ragData), 'utf-8');
      log.info(`✅ RAG generato: ${validArticles.length} articoli con embeddings`);
    }
  } catch (err) {
    log.error(`❌ Errore inizializzazione RAG: ${err.message}`);
  }
}

/**
 * Query the regolamento and return the most relevant articles.
 * @param {string} query - User's query text
 * @param {number} [topK=5] - Number of top articles to return
 * @returns {Promise<string>} Relevant articles text
 */
async function queryRegolamento(query, topK = 5) {
  if (!ragData || !ragData.articles) return '';

  if (!query || !query.trim()) {
    return ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
  }

  try {
    const [queryEmbedding] = await fetchEmbeddings([query]);

    const scored = ragData.articles.map((article, i) => ({
      article,
      score: cosineSimilarity(queryEmbedding, ragData.embeddings[i]),
    }));

    scored.sort((a, b) => b.score - a.score);
    const relevant = scored.slice(0, topK).filter(s => s.score > 0);

    if (relevant.length === 0) {
      return ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
    }

    return relevant.map(s => s.article.text).join('\n\n');
  } catch (err) {
    log.error(`❌ Errore query RAG: ${err.message}`);
    return ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
  }
}

module.exports = { initRegolamentoRag, queryRegolamento };
