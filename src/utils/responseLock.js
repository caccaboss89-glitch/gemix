// src/utils/responseLock.js
// Simple in-memory response lock per chat to avoid concurrent replies
const locks = new Map();

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

function _now() { return Date.now(); }

function _armExpiry(key, lockId, ttl) {
  return setTimeout(() => {
    const cur = locks.get(key);
    if (cur && cur.lockId === lockId) locks.delete(key);
  }, ttl + 1000);
}

function tryLock(key, ttl = DEFAULT_TTL_MS) {
  const entry = locks.get(key);
  if (entry) {
    if (entry.expiresAt > _now()) return false;
    // expired — clean
    clearTimeout(entry.timeoutId);
    locks.delete(key);
  }

  const expiresAt = _now() + ttl;
  const lockId = Math.random().toString(36).substring(2);
  const timeoutId = _armExpiry(key, lockId, ttl);

  locks.set(key, { expiresAt, timeoutId, lockId });
  return true;
}

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

function startAutoRenew(key, ttl = DEFAULT_TTL_MS, renewEveryMs = Math.max(10_000, Math.floor(ttl / 3))) {
  const timer = setInterval(() => {
    if (!refresh(key, ttl)) {
      clearInterval(timer);
    }
  }, renewEveryMs);
  timer.unref();
  return () => clearInterval(timer);
}

function unlock(key) {
  const entry = locks.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  locks.delete(key);
  return true;
}

module.exports = { tryLock, refresh, startAutoRenew, unlock };
