// src/tools/taskRemover.js
//
// Removes tasks by ID(s) from a personal or group task file using taskStore.

const { modifyTaskFile } = require('../utils/taskStore');

/**
 * Remove tasks by IDs from a user's or group's task file (atomic read-modify-write).
 * @param {string[]} taskIds - Array of task IDs to remove
 * @param {string} fileId - The task file ID (user's personal or group)
 * @returns {Promise<object>} Result message
 */
async function removeTasks(taskIds, fileId) {
  let result = { success: false, error: 'No task file found. You have no scheduled tasks.' };

  await modifyTaskFile(fileId, async (data) => {
    if (!data || !Array.isArray(data.tasks) || data.tasks.length === 0) {
      return data;
    }

    const before = data.tasks.length;
    data.tasks = data.tasks.filter(t => !taskIds.includes(t.id));
    const removed = before - data.tasks.length;

    if (removed === 0) {
      result = { success: false, error: 'No tasks found with the specified IDs.' };
      return data;
    }

    result = { success: true, message: `${removed} task(s) removed successfully.` };
    return data;
  });

  return result;
}

module.exports = { removeTasks };