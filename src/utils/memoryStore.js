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

/**
 * Read the memory content for a given file ID.
 * @param {string} fileId - Memory file ID (e.g., 'member_alberto', 'group_123')
 * @returns {string|null} Memory text or null if not found
 */
function readMemory(fileId) {
  const filePath = path.join(MEMORIES_DIR, `${fileId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.memory || null;
  } catch {
    return null;
  }
}

/**
 * Write memory content for a given file ID. Deletes file if content is empty.
 * @param {string} fileId - Memory file ID
 * @param {string} content - Memory text (max 500 chars)
 * @returns {{ success: boolean, error?: string }}
 */
function writeMemory(fileId, content) {
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

module.exports = { readMemory, writeMemory, MAX_MEMORY_CHARS };
