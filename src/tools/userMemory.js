// src/tools/userMemory.js
//
// Thin wrapper for private per-user persistent memory.
// Delegates to memoryStore (modifyMemory + MAX_MEMORY_CHARS limit).
// Returns simple success/clear/update messages. Companion to groupMemory.js.

const { modifyMemory, resolveMemoryContent, MAX_MEMORY_CHARS } = require('../utils/memoryStore');

/**
 * Update the private memory for the current user.
 * @param {string} content - Memory text to write or append (max 1000 chars total, empty to clear)
 * @param {string} memoryFileId - User's memory file ID
 * @param {boolean} [replace=true] - true = overwrite; false = append to existing memory
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function updatePrivateMemory(content, memoryFileId, replace = true) {
  if (!memoryFileId) {
    return { success: false, error: 'Unable to identify the memory file for this user.' };
  }

  let cleared = false;
  let resolved = '';
  const writeResult = await modifyMemory(memoryFileId, async (existing) => {
    const resolvedContent = resolveMemoryContent(existing, content, replace !== false);
    cleared = resolvedContent.cleared;
    resolved = resolvedContent.content;
    if (!cleared && resolved.length > MAX_MEMORY_CHARS) {
      return { success: false, error: `Content exceeds the ${MAX_MEMORY_CHARS} character limit (${resolved.length} chars).` };
    }
    return resolvedContent;
  });

  if (!writeResult.success) {
    return { success: false, error: writeResult.error };
  }

  if (cleared) {
    return { success: true, message: 'Memory cleared.' };
  }

  const mode = replace === false ? 'appended to' : 'updated';
  return { success: true, message: `Personal memory ${mode} (${resolved.length}/${MAX_MEMORY_CHARS} chars).` };
}

module.exports = { updatePrivateMemory };
