// src/tools/taskRemover.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Removes tasks by ID(s) from a personal or group task file using taskStore.

import constants from '../config/constants.js';
import { modifyTaskFile  } from '../utils/taskStore.js';
import { formatTaskRecipient } from '../utils/taskRecipient.js';
import {
  projectTaskForTool,
  taskErrorsFromResults,
  taskOperationResult
} from '../utils/taskToolResult.js';

function _removeFailure(requestedIds, error, notFound = requestedIds) {
  const results = requestedIds.map((id, index) => taskOperationResult({
    index,
    id,
    success: false,
    error
  }));
  return {
    success: false,
    status: 'failed',
    count: 0,
    requested_count: requestedIds.length,
    not_found_count: notFound.length,
    in_progress_count: 0,
    tasks: [],
    results,
    ids: [],
    errors: results.length > 0
      ? taskErrorsFromResults(results)
      : [{ index: null, id: null, error }],
    removed: [],
    not_found: notFound,
    in_progress: [],
    error
  };
}

function _removedTaskProjection(task, options) {
  const ctx = options.ctx || {};
  const recipient = formatTaskRecipient(task.destinations, {
    isAdmin: ctx.isAdmin,
    waJid: ctx.waJid,
    groupWord: 'group'
  });
  return projectTaskForTool(task, {
    scope: options.scope || 'personal',
    recipient: recipient || (options.scope === 'group' ? 'group' : null)
  });
}

function _taskIsDispatching(task) {
  return Object.values(task?.deliveryClaim?.destinations || {})
    .some(state => state?.status === 'sending');
}

/**
 * Remove tasks by IDs from a user's or group's task file (atomic read-modify-write).
 * @param {string[]} taskIds - Array of task IDs to remove
 * @param {string} fileId - The task file ID (user's personal or group)
 * @param {object} [options] - Projection context { scope, ctx }
 * @returns {Promise<object>} Stable count/tasks/results/ids/errors plus aliases.
 */
async function removeTasks(taskIds, fileId, options = {}) {
  const requestedIds = Array.isArray(taskIds)
    ? [...new Set(taskIds.filter(id => typeof id === 'string' && id))]
    : [];
  if (requestedIds.length === 0) {
    return _removeFailure([], 'Pass at least one task ID to remove.', []);
  }
  if (requestedIds.length > constants.REMOVE_TASKS_MAX_IDS) {
    return _removeFailure(
      requestedIds,
      `Remove at most ${constants.REMOVE_TASKS_MAX_IDS} task IDs in one call.`
    );
  }

  let result = _removeFailure(
    requestedIds,
    'No task file found. You have no scheduled reminders.'
  );

  try {
    await modifyTaskFile(fileId, async (data) => {
      if (!data) return undefined;
      if (!Array.isArray(data.tasks)) throw new Error('Existing task file has an invalid tasks field.');
      if (data.tasks.length === 0) {
        result = _removeFailure(requestedIds, 'You have no scheduled reminders.');
        return undefined;
      }

      const byId = new Map(data.tasks.map(task => [task.id, task]));
      const inProgress = requestedIds.filter(id => _taskIsDispatching(byId.get(id)));
      const inProgressSet = new Set(inProgress);
      const removed = requestedIds.filter(id => byId.has(id) && !inProgressSet.has(id));
      const notFound = requestedIds.filter(id => !byId.has(id));

      if (removed.length === 0) {
        if (inProgress.length === 0) {
          result = _removeFailure(requestedIds, 'No tasks found with the specified IDs.', notFound);
          return undefined;
        }
        const results = requestedIds.map((id, index) => taskOperationResult({
          index,
          id,
          success: false,
          error: inProgressSet.has(id)
            ? 'Task delivery is already in progress and can no longer be cancelled safely.'
            : 'Task ID was not found.'
        }));
        result = {
          success: false,
          status: 'failed',
          count: 0,
          requested_count: requestedIds.length,
          not_found_count: notFound.length,
          in_progress_count: inProgress.length,
          tasks: [],
          results,
          ids: [],
          errors: taskErrorsFromResults(results),
          removed: [],
          not_found: notFound,
          in_progress: inProgress,
          error: 'One or more tasks are already being delivered and cannot be cancelled safely.'
        };
        return undefined;
      }

      const removedSet = new Set(removed);
      const removedTasks = removed.map(id => _removedTaskProjection(byId.get(id), options));
      data.tasks = data.tasks.filter(task => !removedSet.has(task.id));
      const status = notFound.length > 0 || inProgress.length > 0 ? 'degraded' : 'ok';
      const results = requestedIds.map((id, index) => taskOperationResult({
        index,
        id,
        success: removedSet.has(id),
        error: removedSet.has(id)
          ? null
          : inProgressSet.has(id)
            ? 'Task delivery is already in progress and can no longer be cancelled safely.'
            : 'Task ID was not found.'
      }));
      result = {
        success: true,
        status,
        count: removed.length,
        requested_count: requestedIds.length,
        not_found_count: notFound.length,
        in_progress_count: inProgress.length,
        tasks: removedTasks,
        results,
        ids: removed,
        errors: taskErrorsFromResults(results),
        removed,
        not_found: notFound,
        in_progress: inProgress,
        message: `${removed.length} task(s) removed successfully.${notFound.length > 0 ? ` ${notFound.length} requested ID(s) were not found.` : ''}${inProgress.length > 0 ? ` ${inProgress.length} task(s) were already being delivered and were not removed.` : ''}`
      };
      return data;
    });
  } catch (err) {
    return _removeFailure(requestedIds, err.message);
  }

  return result;
}

export { removeTasks };
