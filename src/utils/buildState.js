// src/utils/buildState.js
//
// Per-workspace activity tracking and locking for the `build` sub-agent.
//
// What's stored:
//   - lastActivityAt: ms timestamp updated by handler.js on each WhatsApp main
//     turn (Discord does not touch build workspaces). The workspace TTL counts
//     inactivity from the user's last WhatsApp interaction with GemiX.
//   - lock: { ownerId, acquiredAt, expiresAt } - a per-workspace mutex used
//     by the build tool to serialize concurrent invocations. The lock has
//     a hard expiry.
//
// Both pieces of state live in `<workspaceMetaDir>/.build_state.json` and
// are written atomically (tmp + rename).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBuildWorkspaceMetaDir } = require('./workspaceId');
const { BUILD_LOCK_WAIT_MS, BUILD_HARD_TIMEOUT_MS, DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('BuildState');

const STATE_FILENAME = '.build_state.json';
// Hard ceiling for a held lock: BUILD_HARD_TIMEOUT_MS + 60s margin.
const LOCK_MAX_TTL_MS = BUILD_HARD_TIMEOUT_MS + 60_000;

function _stateFile(workspaceId) {
  const metaDir = getBuildWorkspaceMetaDir(workspaceId);
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
 * Read last activity timestamp (ms) or 0 if unknown.
 */
function getLastActivityAt(workspaceId) {
  const state = _readState(workspaceId);
  return Number(state.lastActivityAt) || 0;
}

/**
 * Try to acquire the build lock for this workspace, polling up to
 * BUILD_LOCK_WAIT_MS. Returns the owner id on success or throws on timeout.
 *
 * Stale locks (held longer than LOCK_MAX_TTL_MS) are reaped automatically.
 */
async function acquireBuildLock(workspaceId, opts = {}) {
  const ownerId = opts.ownerId || crypto.randomBytes(8).toString('hex');
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : BUILD_LOCK_WAIT_MS;
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
        expiresAt: now + LOCK_MAX_TTL_MS,
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
      const err = new Error('build is busy: another request is using this workspace.');
      err.code = 'EBUILDBUSY';
      throw err;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Release the lock for the given ownerId. No-op if a different owner holds it.
 */
function releaseBuildLock(workspaceId, ownerId) {
  if (!workspaceId || !ownerId) return;
  const state = _readState(workspaceId);
  if (state.lock && state.lock.ownerId === ownerId) {
    delete state.lock;
    _writeState(workspaceId, state);
  }
}

/**
 * Push the lock's expiry forward if the given ownerId holds the lock.
 * Called during active build progress.
 */
function renewBuildLock(workspaceId, ownerId) {
  if (!workspaceId || !ownerId) return false;
  const state = _readState(workspaceId);
  if (state.lock && state.lock.ownerId === ownerId) {
    state.lock.expiresAt = Date.now() + LOCK_MAX_TTL_MS;
    _writeState(workspaceId, state);
    return true;
  }
  return false;
}

/**
 * Iterate over every workspace_meta dir under DATA_DIR/users/ that has a
 * build_state file. Returns [{ workspaceSlug, workspaceId, metaDir, workspaceDir, lastActivityAt, lock }].
 * Used by the cron sweeper to find stale workspaces to wipe.
 */
function listWorkspaceStates() {
  const usersDir = path.join(DATA_DIR, 'users');
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
        workspaceDir: path.join(metaDir, 'build_workspace'),
        lastActivityAt: Number(raw && raw.lastActivityAt) || 0,
        lock: raw && raw.lock ? raw.lock : null,
      });
    } catch { /* skip corrupted state file */ }
  }
  return out;
}

module.exports = {
  touchActivity,
  getLastActivityAt,
  acquireBuildLock,
  releaseBuildLock,
  renewBuildLock,
  listWorkspaceStates,
};
