const { writeMemory, MAX_MEMORY_CHARS } = require('../utils/memoryStore');

/**
 * Update the private memory for the current user.
 * @param {string} content - New memory content (max 500 chars, empty to clear)
 * @param {string} memoryFileId - User's memory file ID
 * @returns {string} Result message
 */
function updatePrivateMemory(content, memoryFileId) {
  if (!memoryFileId) {
    return '❌ Unable to identify the memory file for this user.';
  }

  const result = writeMemory(memoryFileId, content);
  if (!result.success) {
    return `❌ ${result.error}`;
  }

  if (!content || content.trim().length === 0) {
    return '✅ Personal memory cleared.';
  }

  return `✅ Personal memory updated (${content.length}/${MAX_MEMORY_CHARS} chars).`;
}

module.exports = { updatePrivateMemory };
