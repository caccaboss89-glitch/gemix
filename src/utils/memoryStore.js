const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const MEMORIES_DIR = path.join(DATA_DIR, 'memories');
const MAX_MEMORY_CHARS = 500;

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

  fs.writeFileSync(filePath, JSON.stringify({ memory: content }, null, 2), 'utf-8');
  return { success: true };
}

module.exports = { readMemory, writeMemory, MAX_MEMORY_CHARS };
