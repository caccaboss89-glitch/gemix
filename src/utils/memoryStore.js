// src/utils/memoryStore.js
//
// Simple persistent key-value memory store for users and groups.
// Each memory is stored as a small JSON file under data/memories/.
// Used by the `update_memory` tool and injected into the system prompt.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const MEMORIES_DIR = path.join(DATA_DIR, 'memories');
const MAX_MEMORY_CHARS = 1000;

if (!fs.existsSync(MEMORIES_DIR)) {
  fs.mkdirSync(MEMORIES_DIR, { recursive: true });
}

// Per-file async lock to prevent concurrent read-modify-write race conditions.
const _locks = new Map();

function _withLock(fileId, fn) {
  const prev = _locks.get(fileId) || Promise.resolve();
  let release;
  const current = new Promise(r => { release = r; });
  _locks.set(fileId, current);
  return prev.then(fn).finally(() => {
    release();
    if (_locks.get(fileId) === current) _locks.delete(fileId);
  });
}

function _readMemoryUnlocked(fileId) {
  const filePath = path.join(MEMORIES_DIR, `${fileId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.memory || null;
  } catch {
    return null;
  }
}

function _writeMemoryUnlocked(fileId, content) {
  const filePath = path.join(MEMORIES_DIR, `${fileId}.json`);

  if (!content || content.trim().length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  }

  if (content.length > MAX_MEMORY_CHARS) {
    return { success: false, error: `Content exceeds the ${MAX_MEMORY_CHARS} character limit (${content.length} chars).` };
  }

  const tempFile = filePath + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify({ memory: content }, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
    return { success: false, error: err.message };
  }
  return { success: true };
}

/**
 * Read the memory content for a given file ID.
 * @param {string} fileId - Memory file ID
 * @returns {string|null} Memory text or null if not found
 */
function readMemory(fileId) {
  return _readMemoryUnlocked(fileId);
}

/**
 * Write memory content for a given file ID. Deletes file if content is empty.
 * Serialized via per-file lock to prevent concurrent write conflicts.
 * @param {string} fileId - Memory file ID
 * @param {string} content - Memory text (max 1000 chars)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function writeMemory(fileId, content) {
  return _withLock(fileId, async () => _writeMemoryUnlocked(fileId, content));
}

/**
 * Atomically read, modify, and write a memory file under a per-file lock.
 * @param {string} fileId - Memory file ID
 * @param {function(existing: string|null): Promise<{ content: string, cleared?: boolean }|{ success: false, error: string }>} fn
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function modifyMemory(fileId, fn) {
  return _withLock(fileId, async () => {
    const existing = _readMemoryUnlocked(fileId);
    const result = await fn(existing);
    if (result && result.success === false) return result;
    const { content, cleared } = result;
    if (cleared && (!content || !content.trim())) {
      return _writeMemoryUnlocked(fileId, '');
    }
    return _writeMemoryUnlocked(fileId, content);
  });
}

/**
 * Combine incoming memory text with existing stored memory.
 * @param {string|null} existing
 * @param {string} content
 * @param {boolean} replace - true = overwrite; false = append
 * @returns {{ content: string, cleared: boolean }}
 */
function resolveMemoryContent(existing, content, replace) {
  const incoming = typeof content === 'string' ? content : '';
  if (!incoming.trim()) {
    return { content: '', cleared: true };
  }
  if (replace) {
    return { content: incoming, cleared: false };
  }
  const prior = typeof existing === 'string' ? existing.trim() : '';
  if (!prior) {
    return { content: incoming, cleared: false };
  }
  return { content: `${prior}\n${incoming.trim()}`, cleared: false };
}

module.exports = {
  readMemory,
  writeMemory,
  modifyMemory,
  resolveMemoryContent,
  MAX_MEMORY_CHARS,
};
