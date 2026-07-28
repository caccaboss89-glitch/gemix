// src/tools/taskReader.js
//
// Reads scheduled reminders (personal and optionally group) from taskStore.
// Formats them with timestamps, recipients, recurrence and IDs into an
// XML-wrapped <ScheduledTasks> message for the main brain. Companion to
// taskRemover and scheduler.

const { readTaskFile } = require('../utils/taskStore');
const { formatTimestamp } = require('../utils/time');
const { normalizePersistedRecurrence, describeRecurrence } = require('../utils/recurrence');
const { formatTaskRecipient } = require('../utils/taskRecipient');

/**
 * Format a single task line.
 * @param {object} t - Task object.
 * @param {number} i - Zero-based index (for numbering).
 * @param {object} ctx - Caller context { isAdmin, isActiveMember, waJid }.
 * @param {boolean} showRecipient - Whether to append the recipient (personal
 *   list only; group tasks are implicitly delivered to the group).
 * @returns {string}
 */
function _formatTask(t, i, ctx, showRecipient) {
  let line = `${i + 1}. "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}"\n   🗓️ ${formatTimestamp(t.scheduledAt)}`;

  const recurrence = normalizePersistedRecurrence(t.recurrence);
  if (recurrence) {
    line += ` | 🔁 ${describeRecurrence(recurrence, 'it')}`;
    if (recurrence.until) line += ` fino al ${formatTimestamp(recurrence.until)}`;
    if (recurrence.exdate.length) line += ` (escluse: ${recurrence.exdate.join(', ')})`;
  }

  // Recipient is only meaningful for active members/admin, who can set
  // reminders for other people; empty for self-reminders (omitted).
  if (showRecipient && (ctx.isActiveMember || ctx.isAdmin)) {
    const recipient = formatTaskRecipient(t.destinations, {
      isAdmin: ctx.isAdmin,
      waJid: ctx.waJid,
      groupWord: 'gruppo',
    });
    if (recipient) line += ` | 👤 ${recipient}`;
  }

  line += ` | ID: \`${t.id}\``;
  return line;
}

/**
 * Read tasks for a specific user or group.
 * Builds a formatted task list with timestamps, recipients and IDs for user reference.
 * @param {string} taskFileId - The user's task file ID (e.g., 'member_test_user' or 'wa_390000000000')
 * @param {string|null} groupTaskFileId - The group's task file ID for group-specific tasks, or null
 * @param {boolean} includeGroup - Whether to include group tasks in the result
 * @param {object} [ctx] - Caller context { isAdmin, isActiveMember, waJid } for recipient display
 * @returns {object} { success, message } with the formatted task list
 */
async function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false, ctx = {}) {
  let result = '';

  const personalData = await readTaskFile(taskFileId);
  if (personalData && personalData.tasks && personalData.tasks.length > 0) {
    result += `📋 **I tuoi task personali:**\n`;
    result += personalData.tasks.map((t, i) => _formatTask(t, i, ctx, true)).join('\n');
  } else {
    result += `📋 Nessun task personale schedulato.`;
  }

  if (includeGroup && groupTaskFileId) {
    const groupData = await readTaskFile(groupTaskFileId);
    if (groupData && groupData.tasks && groupData.tasks.length > 0) {
      result += `\n\n📋 **Task di gruppo:**\n`;
      result += groupData.tasks.map((t, i) => _formatTask(t, i, ctx, false)).join('\n');
    }
  }

  const output = `<ScheduledTasks include_group="${includeGroup}">\n${result || 'Nessun task schedulato.'}\n</ScheduledTasks>`;

  return { success: true, message: output };
}

module.exports = { readTasks };
