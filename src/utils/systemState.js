// src/utils/systemState.js
//
// Persistent key-value store for system-wide state (media quotas, monitors, …).
// Read-modify-write operations are serialized both inside this process and
// across GemiX processes through a short-lived lock file. The on-disk replace
// is atomic, so a restart can only observe the old complete state or the new
// complete state, never a partially written JSON document.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';

const log = createLogger('SystemState');
const STATE_FILE = path.join(constants.DATA_DIR, 'systemState.json');
const LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

// First serialization layer for callers inside this process.
let _lockPromise = Promise.resolve();

const _delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Acquire the process-shared state lock. `wx` is an atomic create on the local
 * filesystem. A token prevents a timed-out former owner from deleting a lock
 * that has already been replaced by a newer owner.
 * @returns {Promise<() => void>} release callback
 */
async function _acquireFileLock() {
  if (!fs.existsSync(constants.DATA_DIR)) fs.mkdirSync(constants.DATA_DIR, { recursive: true });
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  const startedAt = Date.now();

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      try {
        fs.writeFileSync(fd, token, 'utf-8');
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.unlinkSync(LOCK_FILE); } catch { /* best effort */ }
        throw writeErr;
      }
      return () => {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try {
          if (fs.readFileSync(LOCK_FILE, 'utf-8') === token) fs.unlinkSync(LOCK_FILE);
        } catch { /* another owner or an already removed lock */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const stat = fs.statSync(LOCK_FILE);
        const staleToken = fs.readFileSync(LOCK_FILE, 'utf-8');
        const ownerPid = Number.parseInt(staleToken.split(':', 1)[0], 10);
        let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
        if (ownerAlive) {
          try { process.kill(ownerPid, 0); }
          catch (ownerErr) { ownerAlive = ownerErr.code !== 'ESRCH'; }
        }
        if (!ownerAlive || Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          if (fs.readFileSync(LOCK_FILE, 'utf-8') === staleToken) fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch (lockErr) {
        if (lockErr.code === 'ENOENT') continue;
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the system state lock (${LOCK_TIMEOUT_MS} ms)`);
      }
      await _delay(LOCK_RETRY_MS);
    }
  }
}

async function _withLock(fn) {
  let release;
  const currentLock = _lockPromise;
  _lockPromise = new Promise(r => { release = r; });
  await currentLock;
  let releaseFileLock;
  try {
    releaseFileLock = await _acquireFileLock();
    return await fn();
  } finally {
    releaseFileLock?.();
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

function _writeRaw(state) {
  const tempFile = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    if (!fs.existsSync(constants.DATA_DIR)) fs.mkdirSync(constants.DATA_DIR, { recursive: true });

    // Write to a temporary file first
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');

    // Rename to the actual file (atomic operation on most filesystems)
    fs.renameSync(tempFile, STATE_FILE);

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
