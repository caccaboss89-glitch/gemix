const { readMemory, writeMemory, MAX_MEMORY_CHARS } = require('../utils/memoryStore');

/**
 * Update the private memory for the current user.
 * @param {string} content - New memory content (max 500 chars, empty to clear)
 * @param {string} memoryFileId - User's memory file ID
 * @returns {string} Result message
 */
function updatePrivateMemory(content, memoryFileId) {
  if (!memoryFileId) {
    return '❌ Impossibile identificare il file memoria per questo utente.';
  }

  const result = writeMemory(memoryFileId, content);
  if (!result.success) {
    return `❌ ${result.error}`;
  }

  if (!content || content.trim().length === 0) {
    return '✅ Memoria personale cancellata.';
  }

  return `✅ Memoria personale aggiornata (${content.length}/${MAX_MEMORY_CHARS} caratteri).`;
}

module.exports = { updatePrivateMemory };
