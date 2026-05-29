// src/tools/groupMemory.js
const { writeMemory, MAX_MEMORY_CHARS } = require('../utils/memoryStore');
const { getGroupTaskFileId } = require('../utils/userIdentifier');

/**
 * Update the group memory for the current WhatsApp group.
 * @param {string} content - New memory content (max 1000 chars, empty to clear)
 * @param {string} groupId - WhatsApp group ID
 * @returns {string} Result message
 */
function updateGroupMemory(content, groupId) {
  if (!groupId) {
    return { success: false, error: 'Unable to identify the current group.' };
  }

  const memoryFileId = 'memory_' + getGroupTaskFileId(groupId);
  const result = writeMemory(memoryFileId, content);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (!content || content.trim().length === 0) {
    return { success: true, message: 'Group memory cleared.' };
  }

  return { success: true, message: `Group memory updated (${content.length}/${MAX_MEMORY_CHARS} chars).` };
}

module.exports = { updateGroupMemory };
