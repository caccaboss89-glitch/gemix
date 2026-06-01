// src/utils/regolamento.js
//
// Single-source loader for the Discord server rules (Statuto Albertino).
// The file is small (~24KB ≈ 6k tokens) so we inject it full-context in
// the Discord system prompt instead of running an embedding-based RAG.
//
// Cached in-memory after the first read; the underlying file rarely
// changes and a manual restart picks up edits.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('Regolamento');

const REGOLAMENTO_PATH = path.join(DATA_DIR, 'regolamento.txt');
let _cached = null;

/**
 * Read the full server rules text. Returns an empty string if the file is
 * missing so the caller can branch without exceptions.
 * @returns {string}
 */
function loadRegolamento() {
  if (_cached !== null) return _cached;
  try {
    if (!fs.existsSync(REGOLAMENTO_PATH)) {
      log.warn(`regolamento.txt not found at ${REGOLAMENTO_PATH}`);
      _cached = '';
      return _cached;
    }
    _cached = fs.readFileSync(REGOLAMENTO_PATH, 'utf-8').trim();
    log.info(`Regolamento loaded (${_cached.length} chars) - full-context inject enabled`);
    return _cached;
  } catch (err) {
    log.error(`Failed to read regolamento.txt: ${err.message}`);
    _cached = '';
    return _cached;
  }
}

module.exports = { loadRegolamento };
