// Simple in-memory response lock per chat to avoid concurrent replies
const locks = new Map();

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

function _now() { return Date.now(); }

function tryLock(key, ttl = DEFAULT_TTL_MS) {
  const entry = locks.get(key);
  if (entry) {
    if (entry.expiresAt > _now()) return false;
    // expired — clean
    clearTimeout(entry.timeoutId);
    locks.delete(key);
  }

  const expiresAt = _now() + ttl;
  const timeoutId = setTimeout(() => {
    const cur = locks.get(key);
    if (cur && cur.expiresAt <= _now()) locks.delete(key);
  }, ttl + 1000);

  locks.set(key, { expiresAt, timeoutId });
  return true;
}

function isLocked(key) {
  const entry = locks.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= _now()) {
    clearTimeout(entry.timeoutId);
    locks.delete(key);
    return false;
  }
  return true;
}

function unlock(key) {
  const entry = locks.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeoutId);
  locks.delete(key);
  return true;
}

module.exports = { tryLock, isLocked, unlock };
