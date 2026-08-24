// src/utils/workspaceState.js
//
// Per-workspace activity tracking and mutation locking.
//
// What's stored:
//   - lastActivityAt: ms timestamp updated by handler.js on each main turn.
//     The workspace TTL counts inactivity from the user's last interaction
//     with GemiX, not from the last file write.
//   - `.workspace_lock/`: an atomically-created per-workspace mutex the
//     mutating tools (write_file / edit_file / shell) hold so foreground tool
//     calls cannot interleave writes, even across Node processes. Reads take no
//     lock and run in parallel. A hard expiry lets a later caller reap a lock
//     left by a crashed process. A background process started by `shell` can
//     outlive the shell call and therefore has to coordinate its own writes.
//
// Activity lives in `<workspaceMetaDir>/.build_state.json`; the lock directory
// is its sibling.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getWorkspaceMetaDir  } from './workspaceId.js';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';
import { sleepWithin } from './turnBudget.js';

const log = createLogger('WorkspaceState');

const STATE_FILENAME = '.build_state.json';
const LOCK_DIRNAME = '.workspace_lock';
const LOCK_OWNER_FILENAME = 'owner.json';
// Hard ceiling for a held lock: the longest a single shell call can run, plus
// margin for the host-side teardown that follows it.
const LOCK_MAX_TTL_MS = constants.SHELL_TIMEOUT_MAX_MS + 60_000;

function _stateFile(workspaceId) {
  const metaDir = getWorkspaceMetaDir(workspaceId);
  if (!metaDir) return null;
  if (!fs.existsSync(metaDir)) {
    try { fs.mkdirSync(metaDir, { recursive: true }); }
    catch (err) { log.warn(`mkdir ${metaDir}: ${err.message}`); return null; }
  }
  return path.join(metaDir, STATE_FILENAME);
}

function _readState(workspaceId) {
  const fp = _stateFile(workspaceId);
  if (!fp || !fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) || {};
  } catch (err) {
    log.warn(`Corrupted state for ${workspaceId}: ${err.message}; resetting`);
    return {};
  }
}

function _writeState(workspaceId, state) {
  const fp = _stateFile(workspaceId);
  if (!fp) return false;
  const tmp = `${fp}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmp, fp);
    return true;
  } catch (err) {
    log.warn(`Failed to persist state for ${workspaceId}: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore unlink error */ }
    return false;
  }
}

/**
 * Update the user-activity timestamp for this workspace, once per main turn.
 * The state file is outside the workspace tree and _writeState replaces it
 * atomically, so this bookkeeping must not contend with a long-running shell
 * for the workspace mutation lock.
 */
function touchActivity(workspaceId) {
  if (!workspaceId) return;
  const state = _readState(workspaceId);
  state.lastActivityAt = Date.now();
  state.workspaceId = workspaceId;
  _writeState(workspaceId, state);
}

function readWorkspaceActivity(workspaceId) {
  const state = _readState(workspaceId);
  return {
    workspaceId: typeof state.workspaceId === 'string' ? state.workspaceId : null,
    lastActivityAt: Number(state.lastActivityAt) || 0
  };
}

/**
 * Resolve the atomic lock directory, creating the workspace meta directory.
 */
function _lockDir(workspaceId) {
  const stateFile = _stateFile(workspaceId);
  return stateFile ? path.join(path.dirname(stateFile), LOCK_DIRNAME) : null;
}

function _readLockAt(lockDir) {
  if (!lockDir) return null;
  let stat;
  try { stat = fs.lstatSync(lockDir); }
  catch { return null; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;

  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(lockDir, LOCK_OWNER_FILENAME), 'utf-8')); }
  catch { /* a creator may still be writing owner.json */ }
  return {
    ownerId: owner && typeof owner.ownerId === 'string' ? owner.ownerId : null,
    acquiredAt: Number(owner && owner.acquiredAt) || stat.mtimeMs,
    expiresAt: Number(owner && owner.expiresAt) || stat.mtimeMs + LOCK_MAX_TTL_MS,
    dev: stat.dev,
    ino: stat.ino
  };
}

function _sameIdentity(stat, snapshot) {
  return Boolean(stat && snapshot && stat.dev === snapshot.dev && stat.ino === snapshot.ino);
}

/** Move and remove an expired generation without deleting a replacement lock. */
function _reapExpiredLock(lockDir, now) {
  const snapshot = _readLockAt(lockDir);
  if (!snapshot || snapshot.expiresAt > now) return false;

  try {
    if (!_sameIdentity(fs.lstatSync(lockDir), snapshot)) return false;
  } catch {
    return true;
  }

  const quarantine = `${lockDir}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockDir, quarantine);
    const moved = fs.lstatSync(quarantine);
    if (!_sameIdentity(moved, snapshot)) {
      // A replacement appeared in the tiny check/rename window. Restore it if
      // possible; never delete a generation we did not identify as stale.
      try { fs.renameSync(quarantine, lockDir); }
      catch (err) { log.error(`Could not restore raced workspace lock ${quarantine}: ${err.message}`); }
      return false;
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Could not reap expired workspace lock ${lockDir}: ${err.message}`);
    return err.code === 'ENOENT';
  }
}

/**
 * Try to acquire the mutation lock for this workspace, polling up to
 * constants.WORKSPACE_LOCK_WAIT_MS. Returns an ownership token on success or
 * throws on timeout or when the caller's signal is aborted.
 *
 * Stale locks (held longer than LOCK_MAX_TTL_MS) are reaped automatically.
 */
async function acquireWorkspaceLock(workspaceId, opts = {}) {
  const ownerId = opts.ownerId || crypto.randomBytes(8).toString('hex');
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : constants.WORKSPACE_LOCK_WAIT_MS;
  const signal = opts.signal || null;
  const start = Date.now();
  const lockDir = _lockDir(workspaceId);
  if (!lockDir) throw new Error('Cannot resolve workspace lock directory.');

  while (true) {
    if (signal?.aborted) {
      const err = new Error('The workspace lock wait ended because this turn ended.');
      err.code = 'EWORKSPACEBUSY';
      throw err;
    }
    const now = Date.now();
    try {
      fs.mkdirSync(lockDir);
      const stat = fs.lstatSync(lockDir);
      const token = {
        ownerId,
        acquiredAt: now,
        expiresAt: now + LOCK_MAX_TTL_MS,
        lockDir,
        dev: stat.dev,
        ino: stat.ino
      };
      try {
        fs.writeFileSync(
          path.join(lockDir, LOCK_OWNER_FILENAME),
          JSON.stringify({ ownerId, acquiredAt: token.acquiredAt, expiresAt: token.expiresAt }),
          { encoding: 'utf-8', flag: 'wx' }
        );
        return token;
      } catch (err) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
        throw err;
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (_reapExpiredLock(lockDir, now)) continue;
    }

    if (Date.now() - start >= waitMs) {
      const err = new Error('The workspace is busy: another operation on this conversation is still running.');
      err.code = 'EWORKSPACEBUSY';
      throw err;
    }
    await sleepWithin(500, signal);
  }
}

/**
 * Release the exact lock generation represented by `token`. No-op if it has
 * expired and another process already replaced it.
 */
function releaseWorkspaceLock(workspaceId, token) {
  if (!workspaceId || !token || typeof token !== 'object') return;
  const lockDir = token.lockDir || _lockDir(workspaceId);
  if (!lockDir) return;

  let current;
  try { current = fs.lstatSync(lockDir); }
  catch { return; }
  if (!_sameIdentity(current, token)) return;

  const owner = _readLockAt(lockDir);
  if (!owner || owner.ownerId !== token.ownerId || !_sameIdentity(owner, token)) return;

  const quarantine = `${lockDir}.release.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(lockDir, quarantine);
    if (_sameIdentity(fs.lstatSync(quarantine), token)) {
      fs.rmSync(quarantine, { recursive: true, force: true });
    } else {
      try { fs.renameSync(quarantine, lockDir); } catch { /* preserve the moved generation */ }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Could not release workspace lock ${lockDir}: ${err.message}`);
  }
}

/**
 * Run `fn` holding the workspace mutation lock, releasing it whatever happens.
 * Every write/edit/shell call goes through here, which serializes foreground
 * mutations per workspace while leaving reads unlocked. Background processes
 * launched by shell outlive this scope and are not serialized here.
 *
 * @param {string} workspaceId
 * @param {object} opts - forwarded to acquireWorkspaceLock
 * @param {Function} fn - async () => T
 * @returns {Promise<T>}
 */
async function withWorkspaceLock(workspaceId, opts, fn) {
  const token = await acquireWorkspaceLock(workspaceId, opts);
  try {
    return await fn();
  } finally {
    releaseWorkspaceLock(workspaceId, token);
  }
}

/**
 * Iterate over every workspace meta dir under constants.DATA_DIR/users/ that
 * has a state file. Returns [{ workspaceSlug, workspaceId, metaDir,
 * lastActivityAt }].
 * Used by the cron sweeper to find stale workspaces.
 */
function listWorkspaceStates() {
  const usersDir = path.join(constants.DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) return [];

  const out = [];
  let entries;
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('user_') && !e.name.startsWith('group_')) continue;
    const metaDir = path.join(usersDir, e.name);
    const stateFile = path.join(metaDir, STATE_FILENAME);
    if (!fs.existsSync(stateFile)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      out.push({
        workspaceSlug: e.name,
        workspaceId: raw && typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
        metaDir,
        lastActivityAt: Number(raw && raw.lastActivityAt) || 0
      });
    } catch { /* skip corrupted state file */ }
  }
  return out;
}

export {
  touchActivity,
  readWorkspaceActivity,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  withWorkspaceLock,
  listWorkspaceStates
};
