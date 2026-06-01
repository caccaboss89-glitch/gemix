// src/tools/userMemory.js
//
// Thin wrapper for private per-user persistent memory.
// Delegates to memoryStore (writeMemory + MAX_MEMORY_CHARS limit).
// Returns simple success/clear/update messages. Companion to groupMemory.js.

const { writeMemory, MAX_MEMORY_CHARS } = require('../utils/memoryStore');

/**
 * Update the private memory for the current user.
 * @param {string} content - New memory content (max 1000 chars, empty to clear)
 * @param {string} memoryFileId - User's memory file ID
 * @returns {string} Result message
 */
function updatePrivateMemory(content, memoryFileId) {
  if (!memoryFileId) {
    return { success: false, error: 'Unable to identify the memory file for this user.' };
  }

  const result = writeMemory(memoryFileId, content);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!content || content.trim().length === 0) {
    return { success: true, message: 'Personal memory cleared.' };
  }

  return { success: true, message: `Personal memory updated (${content.length}/${MAX_MEMORY_CHARS} chars).` };
}

module.exports = { updatePrivateMemory };
