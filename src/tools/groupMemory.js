// src/tools/groupMemory.js
//
// Thin wrapper for group-level persistent memory (WhatsApp groups only).
// Derives a stable file key via getGroupTaskFileId (userIdentifier) and delegates
// to the centralized memoryStore (modifyMemory + MAX_MEMORY_CHARS enforcement).
// Returns simple success/error or confirmation messages for the main brain.
// Companion to userMemory.js.

const { modifyMemory, resolveMemoryContent, MAX_MEMORY_CHARS } = require('../utils/memoryStore');
const { getGroupTaskFileId } = require('../utils/userIdentifier');

/**
 * Update the group memory for the current WhatsApp group.
 * @param {string} content - Memory text to write or append (max 1000 chars total, empty to clear)
 * @param {string} groupId - WhatsApp group ID
 * @param {boolean} [replace=true] - true = overwrite; false = append to existing memory
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function updateGroupMemory(content, groupId, replace = true) {
  if (!groupId) {
    return { success: false, error: 'Unable to identify the current group.' };
  }

  const memoryFileId = 'memory_' + getGroupTaskFileId(groupId);
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
    return { success: true, message: 'Group memory cleared.' };
  }

  const mode = replace === false ? 'appended to' : 'updated';
  return { success: true, message: `Group memory ${mode} (${resolved.length}/${MAX_MEMORY_CHARS} chars).` };
}

module.exports = { updateGroupMemory };
