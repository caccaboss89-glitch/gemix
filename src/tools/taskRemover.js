const fs = require('fs');
const path = require('path');
const { TASKS_DIR } = require('../config/constants');

/**
 * Remove tasks by IDs from a user's or group's task file.
 * @param {string[]} taskIds - Array of task IDs to remove
 * @param {string} fileId - The task file ID (user's personal or group)
 * @returns {string} Result message
 */
function removeTasks(taskIds, fileId) {
  const filePath = path.join(TASKS_DIR, `${fileId}.json`);

  if (!fs.existsSync(filePath)) {
    return 'Nessun file task trovato. Non hai task programmati.';
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return 'Errore nella lettura del file task.';
  }

  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => !taskIds.includes(t.id));
  const removed = before - data.tasks.length;

  if (data.tasks.length === 0) {
    // Remove empty file
    fs.unlinkSync(filePath);
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  if (removed === 0) {
    return `Nessun task trovato con gli ID specificati.`;
  }

  return `✅ ${removed} task rimoss${removed === 1 ? 'o' : 'i'} con successo.`;
}

module.exports = { removeTasks };
