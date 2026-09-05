// src/utils/taskStore.js
//
// Persistent storage layer for scheduled reminders (reminders).
// Handles read/write/modify operations on per-user/group task files
// with per-file async locking to prevent race conditions.

import fs from 'fs';
import path from 'path';

const fsPromises = fs.promises;
import constants from '../config/constants.js';
import { withKeyedLock  } from './keyedLock.js';

if (!fs.existsSync(constants.TASKS_DIR)) {
  fs.mkdirSync(constants.TASKS_DIR, { recursive: true });
}

// Per-file async lock to prevent concurrent read-modify-write race conditions.
const _locks = new Map();

const _withLock = (fileId, fn) => withKeyedLock(_locks, fileId, fn);

/**
 * Read task data from a task file.
 * @param {string} fileId - The task file ID
 * @returns {Promise<{ tasks: Array }|null>} Parsed task data, or null only when the file does not exist
 */
async function readTaskFile(fileId) {
  const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
  try {
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Cannot read task file ${fileId}: ${err.message}`, { cause: err });
  }
}

/**
 * Atomically read, modify, and write a task file under a per-file lock.
 * Guarantees no other read-modify-write can interleave, even across async operations.
 * @param {string} fileId - The task file ID
 * @param {function(data: object|null): Promise<object|null>} fn - Modifier; receives current data (or null),
 *   should return the updated data object, or null/undefined to skip writing.
 * @returns {Promise<void>}
 */
async function modifyTaskFile(fileId, fn) {
  return _withLock(fileId, async () => {
    const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
    let data;
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      data = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') data = null;
      else throw new Error(`Cannot read task file ${fileId}: ${err.message}`, { cause: err });
    }
    const result = await fn(data);
    if (result === undefined || result === null) return;
    const hasQuarantinedTasks = Array.isArray(result.quarantinedTasks)
      && result.quarantinedTasks.length > 0;
    if (!result.tasks || (result.tasks.length === 0 && !hasQuarantinedTasks)) {
      try {
        await fsPromises.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new Error(`Cannot remove empty task file ${fileId}: ${err.message}`, { cause: err });
        }
      }
      return;
    }
    const tempPath = filePath + '.tmp';
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(result, null, 2));
      await fsPromises.rename(tempPath, filePath);
    } catch (err) {
      try { await fsPromises.unlink(tempPath); } catch { /* best effort */ }
      throw err;
    }
  });
}

/** Delete one task file under the same lock used by scheduler/tool mutations. */
async function deleteTaskFile(fileId) {
  if (!fileId) return true;
  return _withLock(fileId, async () => {
    const filePath = path.join(constants.TASKS_DIR, `${fileId}.json`);
    try {
      await fsPromises.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw new Error(`Cannot delete task file ${fileId}: ${err.message}`, { cause: err });
    }
  });
}

export { readTaskFile, modifyTaskFile, deleteTaskFile };
