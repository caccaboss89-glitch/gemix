const fs = require('fs');
const path = require('path');
const { TASKS_DIR } = require('../config/constants');
const { formatTimestamp } = require('../utils/time');

/**
 * Read tasks for a specific user or group.
 * Builds a formatted task list with timestamps and IDs for user reference.
 * @param {string} taskFileId - The user's task file ID (e.g., 'member_alberto' or 'wa_393922348132')
 * @param {string|null} groupTaskFileId - The group's task file ID for group-specific tasks, or null
 * @param {boolean} includeGroup - Whether to include group tasks in the result
 * @returns {string} Formatted task list with emojis and timestamps
 */
function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false) {
  let result = '';

  const personalPath = path.join(TASKS_DIR, `${taskFileId}.json`);
  if (fs.existsSync(personalPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(personalPath, 'utf-8'));
      if (data.tasks && data.tasks.length > 0) {
        result += `📋 **I tuoi task personali:**\n`;
        result += data.tasks.map((t, i) =>
          `${i + 1}. [${t.type.toUpperCase()}] "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"\n   🗓️ ${formatTimestamp(t.scheduledAt)} | ID: \`${t.id}\``
        ).join('\n');
      } else {
        result += `📋 Nessun task personale programmato.`;
      }
    } catch {
      result += `📋 Nessun task personale programmato.`;
    }
  } else {
    result += `📋 Nessun task personale programmato.`;
  }

  if (includeGroup && groupTaskFileId) {
    const groupPath = path.join(TASKS_DIR, `${groupTaskFileId}.json`);
    if (fs.existsSync(groupPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(groupPath, 'utf-8'));
        if (data.tasks && data.tasks.length > 0) {
          result += `\n\n📋 **Task del gruppo:**\n`;
          result += data.tasks.map((t, i) =>
            `${i + 1}. [${t.type.toUpperCase()}] "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"\n   🗓️ ${formatTimestamp(t.scheduledAt)} | ID: \`${t.id}\``
          ).join('\n');
        }
      } catch {}
    }
  }

  return result || 'Nessun task programmato.';
}

module.exports = { readTasks };
