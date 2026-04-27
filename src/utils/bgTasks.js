// src/utils/bgTasks.js
// Lightweight in-memory tracker for background bash tasks.
// Allows read_file to detect pending background output and wait for completion.

const BG_TASK_TTL_MS = 5 * 60 * 1000; // auto-expire after 5 min

const _pending = new Map(); // Map<absOutputPath, { doneMarkerPath, startedAt, timeoutMs }>

function registerBgTask(absOutputPath, doneMarkerPath, timeoutMs) {
  _pending.set(absOutputPath, { doneMarkerPath, startedAt: Date.now(), timeoutMs });
  // Prune stale entries
  const cutoff = Date.now() - BG_TASK_TTL_MS;
  for (const [key, val] of _pending) {
    if (val.startedAt < cutoff) _pending.delete(key);
  }
}

function getBgTask(absOutputPath) {
  const task = _pending.get(absOutputPath);
  if (!task) return null;
  if (Date.now() - task.startedAt > BG_TASK_TTL_MS) {
    _pending.delete(absOutputPath);
    return null;
  }
  return task;
}

function removeBgTask(absOutputPath) {
  _pending.delete(absOutputPath);
}

module.exports = { registerBgTask, getBgTask, removeBgTask };
