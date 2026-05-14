// src/rag/regolamentoRag.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config/constants');
const { OPENROUTER_API_KEY, EMBEDDING_MODEL } = require('../config/env');
const { OPENROUTER_BASE_URL } = require('../config/constants');
const { createLogger } = require('../utils/logger');

const log = createLogger('RAG');

const REGOLAMENTO_PATH = path.join(DATA_DIR, 'regolamento.txt');
const RAG_INDEX_PATH = path.join(DATA_DIR, 'regolamento_rag.json');
const MIN_TEXT_LENGTH = 50;

/** Runtime RAG data: articles + embeddings arrays (parallel indices). */
let ragData = null;

// ────────────────────────────── Parsing ──────────────────────────────

function parseArticles(content) {
  const articles = [];
  const lines = content.split('\n');
  let currentId = '';
  let currentTitle = '';
  let currentText = '';

  for (const line of lines) {
    const m = line.match(/^ART\.\s*(\d+)\s*-\s*(.+)/);
    if (m) {
      if (currentId) articles.push({ id: currentId, title: currentTitle, text: currentText.trim() });
      currentId = `ART. ${m[1]}`;
      currentTitle = m[2].trim();
      currentText = line + '\n';
    } else if (currentId) {
      currentText += line + '\n';
    } else if (line.trim()) {
      currentId = 'PREAMBOLO';
      currentTitle = line.trim();
      currentText = line + '\n';
    }
  }
  if (currentId) articles.push({ id: currentId, title: currentTitle, text: currentText.trim() });
  return articles;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ────────────────────────────── Embedding API ──────────────────────────────

/**
 * Fetch a single embedding vector from OpenRouter.
 */
async function fetchEmbedding(text) {
  const res = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Embedding API HTTP ${res.status}: ${body.substring(0, 300)}`);
  }
  const json = await res.json();
  return json.data[0].embedding;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ────────────────────────────── Cache management ──────────────────────────────

/**
 * Load existing cache from disk.
 * Cache format: { embeddingsByHash: { [sha256]: number[] }, model: string }
 */
function loadCache() {
  if (!fs.existsSync(RAG_INDEX_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(RAG_INDEX_PATH, 'utf-8'));
    // Invalidate if embedding model changed
    if (data.model !== EMBEDDING_MODEL) {
      log.info('🔄 Embedding model changed, cache invalidated');
      return {};
    }
    return data.embeddingsByHash || {};
  } catch { return {}; }
}

function saveCache(embeddingsByHash) {
  const tempFile = RAG_INDEX_PATH + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ model: EMBEDDING_MODEL, embeddingsByHash }), 'utf-8');
    fs.renameSync(tempFile, RAG_INDEX_PATH);
  } catch {
    if (fs.existsSync(tempFile)) { try { fs.unlinkSync(tempFile); } catch {} }
  }
}

// ────────────────────────────── Init & Query ──────────────────────────────

async function initRegolamentoRag() {
  try {
    log.info('⏳ Initializing RAG...');
    
    if (!fs.existsSync(REGOLAMENTO_PATH)) {
      log.warn(`⚠️ regolamento.txt not found in ${REGOLAMENTO_PATH}`);
      log.warn('⚠️ RAG not initialized: create data/regolamento.txt to enable it');
      return;
    }

    const content = fs.readFileSync(REGOLAMENTO_PATH, 'utf-8');
    const articles = parseArticles(content).filter(a => a.text.trim().length >= MIN_TEXT_LENGTH);

    if (articles.length === 0) {
      log.warn('⚠️ No valid articles in regolamento');
      return;
    }

    log.info(`📄 ${articles.length} article(s) found, generating embeddings...`);

    const cachedEmbeddings = loadCache();
    const embeddingsByHash = {};
    const embeddings = [];
    let generated = 0;

    for (const article of articles) {
      const hash = hashText(article.text);

      if (cachedEmbeddings[hash]) {
        embeddingsByHash[hash] = cachedEmbeddings[hash];
        embeddings.push(cachedEmbeddings[hash]);
      } else {
        const embedding = await fetchEmbedding(article.text);
        embeddingsByHash[hash] = embedding;
        embeddings.push(embedding);
        generated++;

        if (generated % 10 === 0) {
          log.info(`  ⏳ ${generated} new embedding(s) generated...`);
        }
      }
    }

    saveCache(embeddingsByHash);
    ragData = { articles, embeddings };

    if (generated > 0) {
      log.info(`✅ RAG ready: ${articles.length} article(s) (${generated} new, ${articles.length - generated} from cache)`);
    } else {
      log.info(`✅ RAG loaded from cache (${articles.length} article(s))`);
    }
  } catch (err) {
    log.error(`❌ RAG initialization error: ${err.message}`);
  }
}

async function queryRegolamento(query, topK = 5) {
  if (!ragData?.articles || !ragData?.embeddings || ragData.embeddings.length === 0) return '';

  if (!query?.trim()) {
    return ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
  }

  try {
    const queryEmbedding = await fetchEmbedding(query);

    const scored = ragData.articles.map((article, i) => ({
      article,
      score: ragData.embeddings[i] ? cosineSimilarity(queryEmbedding, ragData.embeddings[i]) : 0,
    }));

    scored.sort((a, b) => b.score - a.score);
    const relevant = scored.slice(0, topK).filter(s => s.score > 0);

    return relevant.length > 0
      ? relevant.map(s => s.article.text).join('\n\n')
      : ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
  } catch (err) {
    log.error(`❌ RAG query error: ${err.message}`);
    return ragData.articles.slice(0, 3).map(a => a.text).join('\n\n');
  }
}

module.exports = { initRegolamentoRag, queryRegolamento };
