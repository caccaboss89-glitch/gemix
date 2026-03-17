const fs = require('fs');
const path = require('path');
const { TASKS_DIR } = require('../config/constants');

if (!fs.existsSync(TASKS_DIR)) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

/**
 * Read task data from a task file.
 * @param {string} fileId - The task file ID (e.g., 'member_alberto', 'group_123')
 * @returns {{ tasks: Array }|null} Parsed task data or null if file doesn't exist / is corrupt
 */
function readTaskFile(fileId) {
  const filePath = path.join(TASKS_DIR, `${fileId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write task data to a task file. Deletes the file if tasks array is empty.
 * @param {string} fileId - The task file ID
 * @param {{ tasks: Array }} data - Task data to write
 */
function writeTaskFile(fileId, data) {
  const filePath = path.join(TASKS_DIR, `${fileId}.json`);
  if (!data.tasks || data.tasks.length === 0) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { readTaskFile, writeTaskFile };
