// Stable task projection returned by reminder tools. Persistence may gain
// internal scheduler fields over time; the model sees only this compact,
// provider-neutral contract.

import { normalizePersistedRecurrence } from './recurrence.js';

function _deliveryProjection(task) {
  const terminal = task?.deliveryFailure?.status === 'failed' ? task.deliveryFailure : null;
  const previous = !terminal && task?.lastDeliveryFailure ? task.lastDeliveryFailure : null;
  const failure = terminal || previous;
  return {
    status: terminal ? 'failed' : (previous ? 'scheduled_after_failure' : 'scheduled'),
    attempts: Number.isInteger(failure?.attempts) ? failure.attempts : 0,
    last_error: failure?.lastError ? String(failure.lastError) : null
  };
}

/** Project one persisted or newly-created reminder into the public tool shape. */
function projectTaskForTool(task, { scope = 'personal', recipient = null } = {}) {
  const recurrence = normalizePersistedRecurrence(task?.recurrence, task?.scheduledAt);
  return {
    id: typeof task?.id === 'string' ? task.id : null,
    content: typeof task?.content === 'string' ? task.content : '',
    scheduledAt: typeof task?.scheduledAt === 'string' ? task.scheduledAt : null,
    createdAt: typeof task?.createdAt === 'string' ? task.createdAt : null,
    scope,
    recipient: recipient || null,
    recurrence,
    delivery: _deliveryProjection(task)
  };
}

/** Common per-item outcome shape used by schedule/read/remove. */
function taskOperationResult({ index, id = null, success, error = null }) {
  return {
    index,
    id,
    success: Boolean(success),
    status: success ? 'ok' : 'failed',
    error: success ? null : String(error || 'Task operation failed.')
  };
}

/** Errors stay indexed and machine-readable; successful calls return []. */
function taskErrorsFromResults(results) {
  return (Array.isArray(results) ? results : [])
    .filter(result => !result.success)
    .map(result => ({ index: result.index, id: result.id, error: result.error }));
}

/** Stable task-domain failure for context checks that run before a task file operation. */
function taskToolFailure(error) {
  return {
    success: false,
    status: 'failed',
    count: 0,
    tasks: [],
    results: [],
    ids: [],
    errors: [{ index: null, id: null, error: String(error) }],
    error: String(error)
  };
}

export { projectTaskForTool, taskErrorsFromResults, taskOperationResult, taskToolFailure };
