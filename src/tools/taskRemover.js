const { readTaskFile, writeTaskFile } = require('../utils/taskStore');

/**
 * Remove tasks by IDs from a user's or group's task file.
 * @param {string[]} taskIds - Array of task IDs to remove
 * @param {string} fileId - The task file ID (user's personal or group)
 * @returns {string} Result message
 */
function removeTasks(taskIds, fileId) {
  const data = readTaskFile(fileId);

  if (!data) {
    return 'Nessun file task trovato. Non hai task programmati.';
  }

  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => !taskIds.includes(t.id));
  const removed = before - data.tasks.length;

  writeTaskFile(fileId, data);

  if (removed === 0) {
    return `Nessun task trovato con gli ID specificati.`;
  }

  return `✅ ${removed} task rimoss${removed === 1 ? 'o' : 'i'} con successo.`;
}

module.exports = { removeTasks };
