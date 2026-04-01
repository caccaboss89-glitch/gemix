const { readMemory, writeMemory, MAX_MEMORY_CHARS } = require('../utils/memoryStore');
const { getGroupTaskFileId } = require('../utils/userIdentifier');

/**
 * Update the group memory for the current WhatsApp group.
 * @param {string} content - New memory content (max 500 chars, empty to clear)
 * @param {string} groupId - WhatsApp group ID
 * @returns {string} Result message
 */
function updateGroupMemory(content, groupId) {
  if (!groupId) {
    return '❌ Impossibile identificare il gruppo corrente.';
  }

  const memoryFileId = 'memory_' + getGroupTaskFileId(groupId);
  const result = writeMemory(memoryFileId, content);
  if (!result.success) {
    return `❌ ${result.error}`;
  }

  if (!content || content.trim().length === 0) {
    return '✅ Memoria del gruppo cancellata.';
  }

  return `✅ Memoria del gruppo aggiornata (${content.length}/${MAX_MEMORY_CHARS} caratteri).`;
}

module.exports = { updateGroupMemory };
