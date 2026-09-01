// src/utils/systemState.js
//
// Persistent key-value store for system-wide state (media quotas, monitors, …).
// Provides atomic read-modify-write operations via an in-memory lock.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';

const log = createLogger('SystemState');
const STATE_FILE = path.join(constants.DATA_DIR, 'systemState.json');

// In-memory lock to ensure atomic read-modify-write
let _lockPromise = Promise.resolve();

async function _withLock(fn) {
  let release;
  const currentLock = _lockPromise;
  _lockPromise = new Promise(r => { release = r; });
  await currentLock;
  try {
    return await fn();
  } finally {
    release();
  }
}

function _readRaw() {
  if (!fs.existsSync(STATE_FILE)) return {};
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  if (!raw.trim()) return {}; // Empty file
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error(`CRITICAL: systemState.json is corrupted! ${err.message}`);
    // Throwing ensures update() doesn't proceed to overwrite it with empty state
    throw new Error(`System state corruption: ${err.message}`);
  }
}

/** Retries for a rename another reader is briefly blocking, and the pause between them. */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20;

/**
 * Replace the state file with the temp one, retrying while something else holds
 * the destination open. On Windows a rename over a file another process is
 * reading fails with EPERM/EBUSY, and every reader here holds it only for the
 * length of one readFileSync — so a short pause is enough.
 */
function _renameOverState(tempFile) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempFile, STATE_FILE);
      return;
    } catch (err) {
      const contended = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!contended || attempt >= RENAME_ATTEMPTS) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS);
    }
  }
}

function _writeRaw(state) {
  // One temp file per process: two writers must never share the staging path.
  const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    if (!fs.existsSync(constants.DATA_DIR)) fs.mkdirSync(constants.DATA_DIR, { recursive: true });

    // Write to a temporary file first
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');

    // Rename to the actual file (atomic operation on most filesystems)
    _renameOverState(tempFile);

    return true;
  } catch (err) {
    log.error(`Failed to write systemState.json: ${err.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
    return false;
  }
}

/**
 * Get state for a specific module.
 * @param {string} moduleName
 * @returns {any}
 */
function get(moduleName) {
  const state = _readRaw();
  return state[moduleName] || null;
}

/**
 * Update state for a specific module.
 * Throws if the write fails so callers cannot treat persistence as successful
 * when disk is unchanged.
 * @param {string} moduleName
 * @param {object|function} newState - New state object or function receiving current module state
 * @returns {Promise<true>}
 */
async function update(moduleName, newState) {
  return _withLock(async () => {
    const state = _readRaw();
    const current = state[moduleName] || {};

    let next;
    if (typeof newState === 'function') {
      next = await newState(current);
    } else {
      next = { ...current, ...newState };
    }

    state[moduleName] = next;
    const ok = _writeRaw(state);
    if (!ok) {
      throw new Error(`Failed to persist system state for module "${moduleName}"`);
    }
    return true;
  });
}

export {
  get,
  update
};
