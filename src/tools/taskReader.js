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
import { projectTaskForTool, taskOperationResult, taskToolFailure } from '../utils/taskToolResult.js';

function _readFailure(error) {
  return taskToolFailure(error);
}

function _taskList(data, label) {
  if (!data) return { ok: true, tasks: [] };
  if (!Array.isArray(data.tasks)) {
    return { ok: false, error: `${label} task file has an invalid tasks field.` };
  }
  const invalidIndex = data.tasks.findIndex(task => (
    !task
    || typeof task !== 'object'
    || typeof task.id !== 'string'
    || typeof task.content !== 'string'
    || typeof task.scheduledAt !== 'string'
  ));
  if (invalidIndex >= 0) {
    return { ok: false, error: `${label} task file contains an invalid reminder at index ${invalidIndex}.` };
  }
  return { ok: true, tasks: data.tasks };
}

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

  const recurrence = normalizePersistedRecurrence(t.recurrence, t.scheduledAt);
  if (recurrence) {
    line += ` | ${describeRecurrence(recurrence, 'en')}`;
    if (recurrence.until) line += ` until ${formatTimestamp(recurrence.until)}`;
    if (recurrence.exdate.length) line += ` (excluded: ${recurrence.exdate.join(', ')})`;
  }

  if (t.deliveryFailure?.status === 'failed') {
    line += ` | DELIVERY FAILED after ${t.deliveryFailure.attempts || '?'} attempt(s)`;
    if (t.deliveryFailure.lastError) line += `: ${String(t.deliveryFailure.lastError).slice(0, 160)}`;
  } else if (t.lastDeliveryFailure) {
    line += ` | previous occurrence failed after ${t.lastDeliveryFailure.attempts || '?'} attempt(s)`;
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
 * @returns {object} Human-readable text plus stable count/tasks/results/ids/errors fields.
 */
async function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false, ctx = {}) {
  let personalData;
  try {
    personalData = await readTaskFile(taskFileId);
  } catch (err) {
    return _readFailure(err.message);
  }
  const personal = _taskList(personalData, 'Personal');
  if (!personal.ok) return _readFailure(personal.error);

  let groupTasks = [];
  if (includeGroup && groupTaskFileId) {
    let groupData;
    try {
      groupData = await readTaskFile(groupTaskFileId);
    } catch (err) {
      return _readFailure(err.message);
    }
    const group = _taskList(groupData, 'Group');
    if (!group.ok) return _readFailure(group.error);
    groupTasks = group.tasks;
  }

  let message = '';
  if (personal.tasks.length > 0) {
    message += 'Your personal reminders:\n';
    message += personal.tasks.map((t, i) => _formatTask(t, i, ctx, true)).join('\n');
  } else {
    message += 'No personal reminders scheduled.';
  }

  if (groupTasks.length > 0) {
    message += '\n\nGroup reminders:\n';
    message += groupTasks.map((t, i) => _formatTask(t, i, ctx, false)).join('\n');
  }

  const tasks = [
    ...personal.tasks.map(task => projectTaskForTool(task, {
      scope: 'personal',
      recipient: formatTaskRecipient(task.destinations, {
        isAdmin: ctx.isAdmin,
        waJid: ctx.waJid,
        groupWord: 'group'
      }) || null
    })),
    ...groupTasks.map(task => projectTaskForTool(task, { scope: 'group', recipient: 'group' }))
  ];
  const results = tasks.map((task, index) => taskOperationResult({
    index,
    id: task.id,
    success: true
  }));

  return {
    success: true,
    status: 'ok',
    count: tasks.length,
    tasks,
    results,
    ids: tasks.map(task => task.id),
    errors: [],
    message: message || 'No reminders scheduled.'
  };
}

export { readTasks };
