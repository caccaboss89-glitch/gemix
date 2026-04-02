const { readTaskFile } = require('../utils/taskStore');
const { formatTimestamp } = require('../utils/time');

/**
 * Read tasks for a specific user or group.
 * Builds a formatted task list with timestamps and IDs for user reference.
 * @param {string} taskFileId - The user's task file ID (e.g., 'member_alberto' or 'wa_393922348132')
 * @param {string|null} groupTaskFileId - The group's task file ID for group-specific tasks, or null
 * @param {boolean} includeGroup - Whether to include group tasks in the result
 * @returns {string} Formatted task list with emojis and timestamps
 */
const FREQ_LABELS = { hourly: 'Ogni ora', daily: 'Ogni giorno', weekly: 'Ogni settimana', monthly: 'Ogni mese' };

function _formatTask(t, i) {
  let line = `${i + 1}. "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"\n   🗓️ ${formatTimestamp(t.scheduledAt)}`;
  if (t.recurrence) {
    line += ` | 🔁 ${FREQ_LABELS[t.recurrence.freq] || t.recurrence.freq} → ${formatTimestamp(t.recurrence.endAt)}`;
  }
  line += ` | ID: \`${t.id}\``;
  return line;
}

function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false) {
  let result = '';

  const personalData = readTaskFile(taskFileId);
  if (personalData && personalData.tasks && personalData.tasks.length > 0) {
    result += `📋 **I tuoi task personali:**\n`;
    result += personalData.tasks.map((t, i) => _formatTask(t, i)).join('\n');
  } else {
    result += `📋 Nessun task personale programmato.`;
  }

  if (includeGroup && groupTaskFileId) {
    const groupData = readTaskFile(groupTaskFileId);
    if (groupData && groupData.tasks && groupData.tasks.length > 0) {
      result += `\n\n📋 **Task del gruppo:**\n`;
      result += groupData.tasks.map((t, i) => _formatTask(t, i)).join('\n');
    }
  }

  return result || 'Nessun task programmato.';
}

module.exports = { readTasks };
