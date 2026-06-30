// src/utils/taskStore.js
//
// Persistent storage layer for scheduled reminders (reminders).
// Handles read/write/modify operations on per-user/group task files
// with per-file async locking to prevent race conditions.

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { TASKS_DIR } = require('../config/constants');

if (!fs.existsSync(TASKS_DIR)) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

// Per-file async lock to prevent concurrent read-modify-write race conditions.
// Uses a Promise chain: each caller waits for the previous one to finish before starting.
const _locks = new Map();

function _withLock(fileId, fn) {
  const prev = _locks.get(fileId) || Promise.resolve();
  let release;
  const current = new Promise(r => { release = r; });
  _locks.set(fileId, current);
  return prev.then(fn).finally(() => {
    release();
    if (_locks.get(fileId) === current) _locks.delete(fileId);
  });
}

/**
 * Read task data from a task file.
 * @param {string} fileId - The task file ID
 * @returns {Promise<{ tasks: Array }|null>} Parsed task data or null if file doesn't exist / is corrupt
 */
async function readTaskFile(fileId) {
  const filePath = path.join(TASKS_DIR, `${fileId}.json`);
  try {
    const raw = await fsPromises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write task data to a task file. Deletes the file if tasks array is empty.
 * Serialized via per-file lock to prevent concurrent write conflicts.
 * @param {string} fileId - The task file ID
 * @param {{ tasks: Array }} data - Task data to write
 * @returns {Promise<void>}
 */
async function writeTaskFile(fileId, data) {
  return _withLock(fileId, async () => {
    const filePath = path.join(TASKS_DIR, `${fileId}.json`);
    if (!data.tasks || data.tasks.length === 0) {
      try { await fsPromises.unlink(filePath); } catch { }
      return;
    }
    const tempPath = filePath + '.tmp';
    await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2));
    await fsPromises.rename(tempPath, filePath);
  });
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
    const filePath = path.join(TASKS_DIR, `${fileId}.json`);
    let data;
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    const result = await fn(data);
    if (result === undefined || result === null) return;
    if (!result.tasks || result.tasks.length === 0) {
      try { await fsPromises.unlink(filePath); } catch { }
      return;
    }
    const tempPath = filePath + '.tmp';
    await fsPromises.writeFile(tempPath, JSON.stringify(result, null, 2));
    await fsPromises.rename(tempPath, filePath);
  });
}

module.exports = { readTaskFile, writeTaskFile, modifyTaskFile };
