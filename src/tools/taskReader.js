// src/tools/taskReader.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Reads scheduled reminders (personal and optionally group) from taskStore.
// Formats them with timestamps, recipients, recurrence and IDs into a
// human-readable list for the main brain. Companion to taskRemover and
// scheduler.

import { readTaskFile  } from '../utils/taskStore.js';
import { formatTimestamp  } from '../utils/time.js';
import { normalizePersistedRecurrence, describeRecurrence  } from '../utils/recurrence.js';
import { formatTaskRecipient  } from '../utils/taskRecipient.js';

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
  let line = `${i + 1}. "${t.content.substring(0, 80)}${t.content.length > 80 ? '...' : ''}" – ${formatTimestamp(t.scheduledAt)}`;

  const recurrence = normalizePersistedRecurrence(t.recurrence);
  if (recurrence) {
    line += ` | ${describeRecurrence(recurrence, 'en')}`;
    if (recurrence.until) line += ` until ${formatTimestamp(recurrence.until)}`;
    if (recurrence.exdate.length) line += ` (excluded: ${recurrence.exdate.join(', ')})`;
  }

  // Recipient is only meaningful for active members/admin, who can set
  // reminders for other people; empty for self-reminders (omitted).
  if (showRecipient && (ctx.isActiveMember || ctx.isAdmin)) {
    const recipient = formatTaskRecipient(t.destinations, {
      isAdmin: ctx.isAdmin,
      waJid: ctx.waJid,
      groupWord: 'group'
    });
    if (recipient) line += ` | recipient: ${recipient}`;
  }

  line += ` | ID: ${t.id}`;
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
    result += 'Your personal reminders:\n';
    result += personalData.tasks.map((t, i) => _formatTask(t, i, ctx, true)).join('\n');
  } else {
    result += 'No personal reminders scheduled.';
  }

  if (includeGroup && groupTaskFileId) {
    const groupData = await readTaskFile(groupTaskFileId);
    if (groupData && groupData.tasks && groupData.tasks.length > 0) {
      result += '\n\nGroup reminders:\n';
      result += groupData.tasks.map((t, i) => _formatTask(t, i, ctx, false)).join('\n');
    }
  }

  return { success: true, message: result || 'No reminders scheduled.' };
}

export default { readTasks };
