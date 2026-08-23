// src/utils/workspaceState.js
//
// Per-workspace activity tracking and mutation locking.
//
// What's stored:
//   - lastActivityAt: ms timestamp updated by handler.js on each main turn.
//     The workspace TTL counts inactivity from the user's last interaction
//     with GemiX, not from the last file write.
//   - lock: { ownerId, acquiredAt, expiresAt } - a per-workspace mutex the
//     mutating tools (write_file / edit_file / shell) hold so two turns on the
//     same conversation cannot interleave writes. Reads take no lock and run in
//     parallel. The lock has a hard expiry so a crashed turn cannot wedge the
//     workspace forever.
//
// Both pieces of state live in `<workspaceMetaDir>/.build_state.json` and are
// written atomically (tmp + rename). The filename is historical and kept so an
// upgrade does not lose an existing workspace's activity timestamp.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getWorkspaceMetaDir  } from './workspaceId.js';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';

const log = createLogger('WorkspaceState');

const STATE_FILENAME = '.build_state.json';
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
  const tmp = fp + '.tmp';
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
 * Update the user-activity timestamp for this workspace. Called by handler.js
 * on every main turn.
 *
 * Also stores the workspaceId in the state.
 */
function touchActivity(workspaceId) {
  if (!workspaceId) return;
  const state = _readState(workspaceId);
  state.lastActivityAt = Date.now();
  state.workspaceId = workspaceId;
  _writeState(workspaceId, state);
}

/**
 * Try to acquire the mutation lock for this workspace, polling up to
 * constants.WORKSPACE_LOCK_WAIT_MS. Returns the owner id on success or throws
 * on timeout.
 *
 * Stale locks (held longer than LOCK_MAX_TTL_MS) are reaped automatically.
 */
async function acquireWorkspaceLock(workspaceId, opts = {}) {
  const ownerId = opts.ownerId || crypto.randomBytes(8).toString('hex');
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : constants.WORKSPACE_LOCK_WAIT_MS;
  const start = Date.now();

  while (true) {
    const state = _readState(workspaceId);
    const now = Date.now();
    const lock = state.lock;
    const isExpired = lock && Number(lock.expiresAt) <= now;
    if (!lock || isExpired) {
      state.lock = {
        ownerId,
        acquiredAt: now,
        expiresAt: now + LOCK_MAX_TTL_MS
      };
      if (_writeState(workspaceId, state)) {
        // Re-read to confirm the lock is held by this ownerId after the write.
        const verify = _readState(workspaceId);
        if (verify.lock && verify.lock.ownerId === ownerId) {
          return ownerId;
        }
      }
    }

    if (Date.now() - start >= waitMs) {
      const err = new Error('The workspace is busy: another operation on this conversation is still running.');
      err.code = 'EWORKSPACEBUSY';
      throw err;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Release the lock for the given ownerId. No-op if a different owner holds it.
 */
function releaseWorkspaceLock(workspaceId, ownerId) {
  if (!workspaceId || !ownerId) return;
  const state = _readState(workspaceId);
  if (state.lock && state.lock.ownerId === ownerId) {
    delete state.lock;
    _writeState(workspaceId, state);
  }
}

/**
 * Run `fn` holding the workspace mutation lock, releasing it whatever happens.
 * Every write/edit/shell call goes through here, which is what serializes
 * mutations per workspace while leaving reads unlocked.
 *
 * @param {string} workspaceId
 * @param {object} opts - forwarded to acquireWorkspaceLock
 * @param {Function} fn - async () => T
 * @returns {Promise<T>}
 */
async function withWorkspaceLock(workspaceId, opts, fn) {
  const ownerId = await acquireWorkspaceLock(workspaceId, opts);
  try {
    return await fn();
  } finally {
    releaseWorkspaceLock(workspaceId, ownerId);
  }
}

/**
 * Iterate over every workspace meta dir under constants.DATA_DIR/users/ that
 * has a state file. Returns [{ workspaceSlug, workspaceId, metaDir,
 * lastActivityAt, lock }]. Used by the cron sweeper to find stale workspaces.
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
        lastActivityAt: Number(raw && raw.lastActivityAt) || 0,
        lock: raw && raw.lock ? raw.lock : null
      });
    } catch { /* skip corrupted state file */ }
  }
  return out;
}

export {
  LOCK_MAX_TTL_MS,
  touchActivity,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  withWorkspaceLock,
  listWorkspaceStates
};
