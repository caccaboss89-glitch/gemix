const { readTaskFile, writeTaskFile } = require('../utils/taskStore');

/**
 * Remove tasks by IDs from a user's or group's task file.
 * @param {string[]} taskIds - Array of task IDs to remove
 * @param {string} fileId - The task file ID (user's personal or group)
 * @returns {string} Result message
 */
async function removeTasks(taskIds, fileId) {
  const data = await readTaskFile(fileId);

  if (!data) {
    return 'No task file found. You have no scheduled tasks.';
  }

  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => !taskIds.includes(t.id));
  const removed = before - data.tasks.length;

  await writeTaskFile(fileId, data);

  if (removed === 0) {
    return `No tasks found with the specified IDs.`;
  }

  return `✅ ${removed} task(s) removed successfully.`;
}

module.exports = { removeTasks };
