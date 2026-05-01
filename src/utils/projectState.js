// src/utils/projectState.js
// Per-user state file: { current_project, last_project, updated_at, lock: { ownerId, ts }, last_crash }.
// Persistent on disk so we survive bot restarts.

const fs = require('fs');
const { PROJECT_STATE_LOCK_TTL_MS } = require('../config/constants');
const { getStateFile, projectExists, getUserRoot, ensureUserSkeleton, resolveStorageId } = require('./userPaths');
const { createLogger } = require('./logger');

const log = createLogger('ProjectState');

// In-memory mutexes per storageId to ensure atomic read-modify-write on .state.json
const _stateLocks = new Map();

async function _withStateLock(userCtx, fn) {
  const id = resolveStorageId(userCtx);
  if (!id) return fn(); // fallback

  while (_stateLocks.get(id)) {
    await _stateLocks.get(id);
  }

  let resolve;
  const promise = new Promise(r => { resolve = r; });
  _stateLocks.set(id, promise);

  try {
    return await fn();
  } finally {
    _stateLocks.delete(id);
    resolve();
  }
}

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
function _readExistingProject(st, key, userCtx) {
  const name = st[key] || null;
  if (name && !projectExists(userCtx, name)) {
    delete st[key];
    return { name: null, dirty: true };
  }
  return { name, dirty: false };
}

function getCurrentProject(userCtx) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    const { name, dirty } = _readExistingProject(st, 'current_project', userCtx);
    if (dirty) {
      _writeRaw(userCtx, st);
    }
    return name;
  });
}

function getLastProject(userCtx) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    const { name, dirty } = _readExistingProject(st, 'last_project', userCtx);
    if (dirty) {
      _writeRaw(userCtx, st);
    }
    return name;
  });
}

function setCurrentProject(userCtx, projectName) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (projectName === null || projectName === undefined) {
      delete st.current_project;
    } else {
      st.current_project = projectName;
      st.last_project = projectName;
    }
    st.updated_at = new Date().toISOString();
    return _writeRaw(userCtx, st);
  });
}

/**
 * Optimistic per-user lock for agentic tool sequences.
 * Returns true if lock acquired (or already held by us in TTL). False otherwise.
 * The lock is advisory and auto-expires after TTL to recover from crashes.
 */
function acquireLock(userCtx, ownerId) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    const now = Date.now();
    const lock = st.lock;
    if (lock && lock.ownerId !== ownerId && now - (lock.ts || 0) < PROJECT_STATE_LOCK_TTL_MS) {
      return false;
    }
    st.lock = { ownerId, ts: now };
    _writeRaw(userCtx, st);
    return true;
  });
}

function refreshLock(userCtx, ownerId) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (!st.lock || st.lock.ownerId !== ownerId) return false;
    st.lock.ts = Date.now();
    return _writeRaw(userCtx, st);
  });
}

function startAutoRenewLock(userCtx, ownerId, renewEveryMs = Math.max(30_000, Math.floor(PROJECT_STATE_LOCK_TTL_MS / 3))) {
  const timer = setInterval(async () => {
    try {
      if (!(await refreshLock(userCtx, ownerId))) {
        clearInterval(timer);
      }
    } catch {
      clearInterval(timer);
    }
  }, renewEveryMs);
  timer.unref();
  return () => clearInterval(timer);
}

function releaseLock(userCtx, ownerId) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (st.lock && st.lock.ownerId === ownerId) {
      delete st.lock;
      _writeRaw(userCtx, st);
    }
  });
}

// ── Crash recovery slot ──
// Stored in the same .state.json under `last_crash`. Injected once into the
// next system prompt and then cleared.

function saveLastCrash(userCtx, payload) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    st.last_crash = { ...payload, ts: Date.now() };
    return _writeRaw(userCtx, st);
  });
}

function consumeLastCrash(userCtx, ttlMs) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (!st.last_crash) return null;
    const fresh = (Date.now() - (st.last_crash.ts || 0)) <= ttlMs;
    const payload = fresh ? st.last_crash : null;
    delete st.last_crash;
    _writeRaw(userCtx, st);
    return payload;
  });
}

function clearLastCrash(userCtx) {
  return _withStateLock(userCtx, async () => {
    const st = _readRaw(userCtx);
    if (!st.last_crash) return true;
    delete st.last_crash;
    return _writeRaw(userCtx, st);
  });
}

// ── Persistent Voice Counts ──

function getVoiceCount(userCtx, chatKey) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (!st.voice_counts) return 0;
    const entry = st.voice_counts[chatKey];
    if (!entry) return 0;
    
    // TTL: 30 minutes
    const VOICE_COUNT_TTL_MS = 30 * 60 * 1000;
    if (Date.now() - (entry.ts || 0) > VOICE_COUNT_TTL_MS) {
      delete st.voice_counts[chatKey];
      _writeRaw(userCtx, st);
      return 0;
    }
    return entry.count || 0;
  });
}

function incrementVoiceCount(userCtx, chatKey) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (!st.voice_counts) st.voice_counts = {};
    const entry = st.voice_counts[chatKey] || { count: 0, ts: 0 };
    
    entry.count = (entry.count || 0) + 1;
    entry.ts = Date.now();
    st.voice_counts[chatKey] = entry;
    
    // Prune other stale entries while we're at it
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const k in st.voice_counts) {
      if (st.voice_counts[k].ts < cutoff) delete st.voice_counts[k];
    }
    
    return _writeRaw(userCtx, st);
  });
}

function resetVoiceCount(userCtx, chatKey) {
  return _withStateLock(userCtx, () => {
    const st = _readRaw(userCtx);
    if (st.voice_counts && st.voice_counts[chatKey]) {
      delete st.voice_counts[chatKey];
      return _writeRaw(userCtx, st);
    }
    return true;
  });
}

module.exports = {
  getCurrentProject,
  getLastProject,
  setCurrentProject,
  acquireLock,
  refreshLock,
  startAutoRenewLock,
  releaseLock,
  saveLastCrash,
  consumeLastCrash,
  clearLastCrash,
  getVoiceCount,
  incrementVoiceCount,
  resetVoiceCount,
};
