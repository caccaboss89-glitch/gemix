// src/tools/scheduler.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Schedules tasks (one-time or recurring) for WhatsApp delivery (private or group).
// Validates dates against DST, 1-year limit, permissions (admin/active member for recipients).
// Uses taskStore for persistence, time utils for Rome timezone handling, and builds
// human-readable confirmation messages with recipient/recurrence details.

import constants from '../config/constants.js';
import {
  taskErrorsFromResults,
  taskOperationResult
} from '../utils/taskToolResult.js';
import { buildScheduledTask } from './scheduledTaskBuilder.js';
import { persistScheduledTaskGroups } from './scheduledTaskPersistence.js';

function _batchMetadata(failedIndices) {
  return {
    atomic_per_task_file: true,
    rollback_across_task_files: false,
    retry_failed_indices: failedIndices
  };
}

function _batchFailure(error, requestedCount = 0) {
  const failedIndices = Array.from({ length: requestedCount }, (_, index) => index);
  return {
    success: false,
    status: 'failed',
    count: 0,
    requested_count: requestedCount,
    failed_count: requestedCount,
    tasks: [],
    results: [],
    ids: [],
    errors: [{ index: null, id: null, error }],
    batch: _batchMetadata(failedIndices),
    error
  };
}

/**
 * Schedule one or more tasks for a user or group.
 * Validates dates, permissions, and destinations before writing to task files.
 * @param {Array} tasks - Array of task objects from GemiX {
 *   content, scheduledAt,
 *   repeat?: RRULE string (e.g. "FREQ=DAILY;INTERVAL=2"),
 *   whatsapp: { toGroup?, toPrivate?, recipient?: { name?, phone? } }
 * }
 * @param {object} ctx - Context { taskFileId, groupTaskFileId, userId, userName, waJid, isActiveMember, isAdmin, isGroup, groupId }
 * @returns {object} Stable count/tasks/results/ids/errors fields, retry indices
 *   and one human-readable verification note.
 */
async function scheduleTasks(tasks, ctx) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return _batchFailure('Pass at least one reminder in "tasks".');
  }
  if (tasks.length > constants.SCHEDULE_TASKS_MAX_BATCH) {
    return _batchFailure(
      `A batch can contain at most ${constants.SCHEDULE_TASKS_MAX_BATCH} reminders.`,
      tasks.length
    );
  }
  const now = new Date();
  const nowTime = now.getTime();
  const maxDateMs = nowTime + constants.MAX_TASK_DAYS * 24 * 60 * 60 * 1000;
  const results = [];
  const pendingWrites = new Map();

  for (const rawTask of tasks) {
    const built = buildScheduledTask(rawTask, ctx, { nowTime, maxDateMs });
    const resultIndex = results.length;
    results.push(built.result);
    if (!built.durableTask) continue;
    if (!pendingWrites.has(built.fileId)) pendingWrites.set(built.fileId, []);
    pendingWrites.get(built.fileId).push({ task: built.durableTask, resultIndex });
  }

  await persistScheduledTaskGroups(pendingWrites, results);

  // Single verification note (pluralized) instead of repeating it per task.
  // Only the time is checked: the message is meant to read as the reminder that
  // arrives then, not as a copy of the words the user used to ask for it.
  const scheduledTasks = [];
  const indexedResults = results.map((result, index) => {
    if (result.success && result.task) scheduledTasks.push(result.task);
    return {
      ...taskOperationResult({
        index,
        id: result.id || null,
        success: result.success,
        error: result.error || null
      }),
      scheduledAt: result.task?.scheduledAt || null,
      ...(result.message ? { message: result.message } : {})
    };
  });
  const okCount = indexedResults.filter(r => r.success).length;
  let verifyNote = null;
  if (okCount === 1) {
    verifyNote = 'Verify scheduledAt is the moment the user asked for. If it is wrong, remove the task by its ID and recreate it.';
  } else if (okCount > 1) {
    verifyNote = 'Verify every scheduledAt is the moment the user asked for. If one is wrong, remove that task by its ID and recreate it.';
  }

  const failedIndices = indexedResults.filter(result => !result.success).map(result => result.index);
  const status = okCount === indexedResults.length ? 'ok' : (okCount > 0 ? 'degraded' : 'failed');
  return {
    success: okCount > 0,
    status,
    count: scheduledTasks.length,
    requested_count: indexedResults.length,
    failed_count: failedIndices.length,
    tasks: scheduledTasks,
    results: indexedResults,
    ids: scheduledTasks.map(task => task.id),
    errors: taskErrorsFromResults(indexedResults),
    batch: _batchMetadata(failedIndices),
    ...(status === 'failed' ? { error: 'No reminders were scheduled. Inspect results and errors.' } : {}),
    ...(verifyNote ? { message: verifyNote } : {})
  };
}

export { scheduleTasks };
