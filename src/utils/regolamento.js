// src/utils/regolamento.js
//
// Single-source loader for the Discord server rules (Statuto Albertino).
// Full text is injected into Discord static instructions as free-form
// "Rules context: …" (not a tool, not a <RulesContext> tag, not Runtime).
//
// Cached in-memory after the first read; the underlying file rarely
// changes and a manual restart picks up edits.

import fs from 'fs';
import path from 'path';
import { DATA_DIR  } from '../config/constants.js';
import { createLogger  } from './logger.js';

const log = createLogger('Regolamento');

const REGOLAMENTO_PATH = path.join(DATA_DIR, 'regolamento.txt');
const REGOLAMENTO_UNAVAILABLE_PLACEHOLDER =
  '[Statuto Albertino unavailable: regolamento.txt could not be loaded on the server. '
  + 'Do not invent articles or rules; tell the user the official statute text is not available in this session.]';
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
      _cached = REGOLAMENTO_UNAVAILABLE_PLACEHOLDER;
      return _cached;
    }
    _cached = fs.readFileSync(REGOLAMENTO_PATH, 'utf-8').trim();
    if (!_cached) {
      log.warn('regolamento.txt is empty');
      _cached = REGOLAMENTO_UNAVAILABLE_PLACEHOLDER;
      return _cached;
    }
    log.info(`Regolamento loaded (${_cached.length} chars) - full-context inject enabled`);
    return _cached;
  } catch (err) {
    log.error(`Failed to read regolamento.txt: ${err.message}`);
    _cached = REGOLAMENTO_UNAVAILABLE_PLACEHOLDER;
    return _cached;
  }
}

export default { loadRegolamento };
