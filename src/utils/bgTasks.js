// src/utils/bgTasks.js
// Lightweight in-memory tracker for background bash tasks.
// Allows read_file to detect pending background output and wait for completion.
//
// Also tracks which (storageId, projectName) pairs have an active background
// task running so that projectRun.js can warn the AI before executing
// potentially conflicting foreground calls (e.g. write_file / bash
// while a background bash is still writing to the same /workspace).

const BG_TASK_TTL_MS = 5 * 60 * 1000; // auto-expire after 5 min

/** Map<absOutputPath, { doneMarkerPath, startedAt, timeoutMs, projectKey? }> */
const _pending = new Map();

/** Set<"storageId::projectName"> — projects with at least one live bg task */
const _activeProjects = new Set();

function _pruneStale() {
  const cutoff = Date.now() - BG_TASK_TTL_MS;
  for (const [key, val] of _pending) {
    if (val.startedAt < cutoff) {
      _pending.delete(key);
      if (val.projectKey) {
        const stillActive = [..._pending.values()].some(t => t.projectKey === val.projectKey);
        if (!stillActive) _activeProjects.delete(val.projectKey);
      }
    }
  }
}

/**
 * Register a new background task.
 * @param {string}  absOutputPath   - Absolute path of the expected output file
 * @param {string}  doneMarkerPath  - Absolute path of the completion marker file
 * @param {number}  timeoutMs       - Timeout passed to the background thread
 * @param {string} [projectKey]     - Optional "storageId::projectName" for concurrency tracking
 */
function registerBgTask(absOutputPath, doneMarkerPath, timeoutMs, projectKey) {
  _pending.set(absOutputPath, { doneMarkerPath, startedAt: Date.now(), timeoutMs, projectKey: projectKey || null });
  if (projectKey) _activeProjects.add(projectKey);
  _pruneStale();
}

function getBgTask(absOutputPath) {
  const task = _pending.get(absOutputPath);
  if (!task) return null;
  if (Date.now() - task.startedAt > BG_TASK_TTL_MS) {
    _pending.delete(absOutputPath);
    if (task.projectKey) {
      const stillActive = [..._pending.values()].some(t => t.projectKey === task.projectKey);
      if (!stillActive) _activeProjects.delete(task.projectKey);
    }
    return null;
  }
  return task;
}

function removeBgTask(absOutputPath) {
  const task = _pending.get(absOutputPath);
  if (task) {
    _pending.delete(absOutputPath);
    if (task.projectKey) {
      const stillActive = [..._pending.values()].some(t => t.projectKey === task.projectKey);
      if (!stillActive) _activeProjects.delete(task.projectKey);
    }
  }
}

/**
 * Returns true if there is at least one live background task for the given
 * storageId + projectName combination.
 * @param {string} storageId
 * @param {string} projectName
 * @returns {boolean}
 */
function hasActiveBgTask(storageId, projectName) {
  _pruneStale(); // ensure stale entries don't give false positives
  return _activeProjects.has(`${storageId}::${projectName}`);
}

module.exports = { registerBgTask, getBgTask, removeBgTask, hasActiveBgTask };
