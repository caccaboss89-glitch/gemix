// src/tools/taskReader.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Reads scheduled reminders (personal and optionally group) from taskStore.
// Projects them with timestamps, recipients, recurrence and IDs into compact
// machine-readable pages for the main brain. Companion to taskRemover and
// scheduler.

import { readTaskFile  } from '../utils/taskStore.js';
import constants from '../config/constants.js';
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
 * Read tasks for a specific user or group.
 * Builds a paged task list with timestamps, recipients and IDs for tool use.
 * @param {string} taskFileId - The user's task file ID (e.g., 'member_test_user' or 'wa_390000000000')
 * @param {string|null} groupTaskFileId - The group's task file ID for group-specific tasks, or null
 * @param {boolean} includeGroup - Whether to include group tasks in the result
 * @param {object} [ctx] - Caller context { isAdmin, isActiveMember, waJid } for recipient display
 * @param {object} [page] - Optional `{ limit, cursor }` page controls.
 * @returns {object} A compact summary plus one page of stable task records.
 */
async function readTasks(taskFileId, groupTaskFileId = null, includeGroup = false, ctx = {}, page = {}) {
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

  const allTasks = [
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
  const rawLimit = page.limit === undefined ? constants.READ_TASKS_MAX_LIMIT : Number(page.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(constants.READ_TASKS_MAX_LIMIT, rawLimit)
    : NaN;
  const cursor = page.cursor === undefined || page.cursor === '' ? 0 : Number(page.cursor);
  if (!Number.isFinite(limit) || !Number.isInteger(cursor) || cursor < 0) {
    return _readFailure('Invalid task page: limit must be a positive number and cursor a non-negative offset.');
  }
  if (cursor > allTasks.length) return _readFailure('Invalid task page: cursor is beyond the end of the task list.');
  const tasks = allTasks.slice(cursor, cursor + limit);
  const nextCursor = cursor + tasks.length < allTasks.length ? String(cursor + tasks.length) : null;
  const summary = allTasks.length === 0
    ? 'No reminders scheduled.'
    : tasks.length === 0
      ? `No more reminders; ${allTasks.length} total.`
      : `Showing reminders ${cursor + 1}-${cursor + tasks.length} of ${allTasks.length}.`;
  const results = tasks.map((task, index) => taskOperationResult({
    index: cursor + index,
    id: task.id,
    success: true
  }));

  return {
    success: true,
    status: 'ok',
    count: tasks.length,
    totalCount: allTasks.length,
    tasks,
    results,
    ids: tasks.map(task => task.id),
    errors: [],
    summary,
    message: summary,
    ...(nextCursor ? { nextCursor } : {})
  };
}

export { readTasks };
