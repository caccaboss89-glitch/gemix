// src/utils/projectState.js
// Per-user state file: { current_project, updated_at, lock: { pid, ts } }.
// Persistent on disk so we survive bot restarts.

const fs = require('fs');
const path = require('path');
const { PROJECT_STATE_LOCK_TTL_MS } = require('../config/constants');
const { getStateFile, projectExists, getUserRoot, ensureUserSkeleton } = require('./userPaths');
const { createLogger } = require('./logger');

const log = createLogger('ProjectState');

function _readRaw(userCtx) {
  const f = getStateFile(userCtx);
  if (!f || !fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch (err) {
    log.warn(`Corrupted state file for user, resetting: ${err.message}`);
    return {};
  }
}

function _writeRaw(userCtx, state) {
  const f = getStateFile(userCtx);
  if (!f) return false;
  try {
    if (!fs.existsSync(getUserRoot(userCtx))) ensureUserSkeleton(userCtx);
    fs.writeFileSync(f, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log.error(`Failed to write state: ${err.message}`);
    return false;
  }
}

/**
 * Return the current project name or null. Auto-clears if the project has
 * been deleted on disk meanwhile.
 */
function getCurrentProject(userCtx) {
  const st = _readRaw(userCtx);
  const name = st.current_project || null;
  if (name && !projectExists(userCtx, name)) {
    // Orphan reference → clean up silently
    delete st.current_project;
    _writeRaw(userCtx, st);
    return null;
  }
  return name;
}

function setCurrentProject(userCtx, projectName) {
  const st = _readRaw(userCtx);
  if (projectName === null || projectName === undefined) {
    delete st.current_project;
  } else {
    st.current_project = projectName;
  }
  st.updated_at = new Date().toISOString();
  return _writeRaw(userCtx, st);
}

/**
 * Optimistic per-user lock for agentic tool sequences.
 * Returns true if lock acquired (or already held by us in TTL). False otherwise.
 * The lock is advisory and auto-expires after TTL to recover from crashes.
 */
function acquireLock(userCtx, ownerId) {
  const st = _readRaw(userCtx);
  const now = Date.now();
  const lock = st.lock;
  if (lock && lock.ownerId !== ownerId && now - (lock.ts || 0) < PROJECT_STATE_LOCK_TTL_MS) {
    return false;
  }
  st.lock = { ownerId, ts: now };
  _writeRaw(userCtx, st);
  return true;
}

function releaseLock(userCtx, ownerId) {
  const st = _readRaw(userCtx);
  if (st.lock && st.lock.ownerId === ownerId) {
    delete st.lock;
    _writeRaw(userCtx, st);
  }
}

// ── Crash recovery slot ──
// Stored in the same .state.json under `last_crash`. Injected once into the
// next system prompt and then cleared.

function saveLastCrash(userCtx, payload) {
  const st = _readRaw(userCtx);
  st.last_crash = { ...payload, ts: Date.now() };
  return _writeRaw(userCtx, st);
}

function consumeLastCrash(userCtx, ttlMs) {
  const st = _readRaw(userCtx);
  if (!st.last_crash) return null;
  const fresh = (Date.now() - (st.last_crash.ts || 0)) <= ttlMs;
  const payload = fresh ? st.last_crash : null;
  delete st.last_crash;
  _writeRaw(userCtx, st);
  return payload;
}

module.exports = {
  getCurrentProject,
  setCurrentProject,
  acquireLock,
  releaseLock,
  saveLastCrash,
  consumeLastCrash,
};
