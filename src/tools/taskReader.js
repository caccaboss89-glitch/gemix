// src/tools/taskReader.js
//
// Reads scheduled reminders (personal and optionally group) from taskStore.
// Formats them with timestamps and IDs into an XML-wrapped <ScheduledTasks> message
// for the main brain. Companion to taskRemover and scheduler.

const { readTaskFile } = require('../utils/taskStore');
const { formatTimestamp } = require('../utils/time');

/**
 * Read tasks for a specific user or group.
 * Builds a formatted task list with timestamps and IDs for user reference.
 * @param {string} taskFileId - The user's task file ID (e.g., 'member_test_user' or 'wa_390000000000')
 * @param {string|null} groupTaskFileId - The group's task file ID for group-specific tasks, or null
 * @param {boolean} includeGroup - Whether to include group tasks in the result
 * @returns {string} Formatted task list with emojis and timestamps
 */
const FREQ_LABELS = {
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

function _formatTask(t, i) {
  let line = `${i + 1}. "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"\n   🗓️ ${formatTimestamp(t.scheduledAt)}`;
  if (t.recurrence) {
    const freqLabel = FREQ_LABELS[t.recurrence.freq] || `Every ${t.recurrence.freq}`;
    line += ` | 🔁 ${freqLabel} -> ${formatTimestamp(t.recurrence.endAt)}`;
  }
  line += ` | ID: \`${t.id}\``;
  return line;
}

async function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false) {
  let result = '';

  const personalData = await readTaskFile(taskFileId);
  if (personalData && personalData.tasks && personalData.tasks.length > 0) {
    result += `📋 **Your personal tasks:**\n`;
    result += personalData.tasks.map((t, i) => _formatTask(t, i)).join('\n');
  } else {
    result += `📋 No personal tasks scheduled.`;
  }

  if (includeGroup && groupTaskFileId) {
    const groupData = await readTaskFile(groupTaskFileId);
    if (groupData && groupData.tasks && groupData.tasks.length > 0) {
      result += `\n\n📋 **Group tasks:**\n`;
      result += groupData.tasks.map((t, i) => _formatTask(t, i)).join('\n');
    }
  }

  const output = `<ScheduledTasks include_group="${includeGroup}">\n${result || 'No tasks scheduled.'}\n</ScheduledTasks>`;

  return { success: true, message: output };
}

module.exports = { readTasks };
