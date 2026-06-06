// src/utils/responseLock.js
//
// Simple in-memory per-chat lock to prevent the bot from generating
// multiple concurrent responses for the same chat. Used by the handler
// to serialize AI calls per conversation.

const locks = new Map();

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

function _now() { return Date.now(); }

function _armExpiry(key, lockId, ttl) {
  return setTimeout(() => {
    const cur = locks.get(key);
    if (cur && cur.lockId === lockId) locks.delete(key);
  }, ttl + 1000);
}

/**
 * Try to acquire a lock for the given chat key.
 * @param {string} key
 * @param {number} [ttl]
 * @returns {boolean} true if lock was acquired
 */
function tryLock(key, ttl = DEFAULT_TTL_MS) {
  const entry = locks.get(key);
  if (entry) {
    if (entry.expiresAt > _now()) return false;
    // expired - clean
    clearTimeout(entry.timeoutId);
    locks.delete(key);
  }

  const expiresAt = _now() + ttl;
  const lockId = Math.random().toString(36).substring(2);
  const timeoutId = _armExpiry(key, lockId, ttl);

  locks.set(key, { expiresAt, timeoutId, lockId });
  return true;
}

/**
 * Refresh/renew an existing lock's TTL.
 * @param {string} key
 * @param {number} [ttl]
 * @returns {boolean}
 */
function refresh(key, ttl = DEFAULT_TTL_MS) {
  const entry = locks.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  entry.expiresAt = _now() + ttl;
  entry.lockId = Math.random().toString(36).substring(2);
  entry.timeoutId = _armExpiry(key, entry.lockId, ttl);
  locks.set(key, entry);
  return true;
}

/**
 * Start an automatic renewal timer for a lock.
 * Returns a function that can be called to stop the auto-renew.
 * @param {string} key
 * @param {number} [ttl]
 * @param {number} [renewEveryMs]
 * @returns {() => void} stop function
 */
function startAutoRenew(key, ttl = DEFAULT_TTL_MS, renewEveryMs = Math.max(10_000, Math.floor(ttl / 3))) {
  const timer = setInterval(() => {
    if (!refresh(key, ttl)) {
      clearInterval(timer);
    }
  }, renewEveryMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Release a lock for the given key.
 * @param {string} key
 * @returns {boolean}
 */
function unlock(key) {
  const entry = locks.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  locks.delete(key);
  return true;
}

module.exports = { tryLock, refresh, startAutoRenew, unlock };
