// src/utils/responseLock.js
//
// Simple in-memory per-chat lock to prevent the bot from generating
// multiple concurrent responses for the same chat. Used by the handler
// to serialize AI calls per conversation.

import constants from '../config/constants.js';
import { createLogger } from './logger.js';

const log = createLogger('ResponseLock');

const locks = new Map();

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * How long one lock may keep renewing itself.
 *
 * Everything a renewal legitimately covers is already bounded: the batch
 * debounce, the history fetch and the turn itself, which ends at
 * constants.TURN_BUDGET_MS. A renewal still running past that is a caller that
 * never released, and because every renewal pushes the expiry forward the lock
 * would stay valid for good - that conversation then stops answering until the
 * process restarts. The margin over the turn budget leaves room for the
 * debounce, the history load and the delivery around it.
 */
const MAX_AUTO_RENEW_MS = constants.TURN_BUDGET_MS + 5 * 60 * 1000;

function _now() { return Date.now(); }

function _armExpiry(key, lockId, ttl) {
  const timer = setTimeout(() => {
    const cur = locks.get(key);
    if (cur && cur.lockId === lockId) locks.delete(key);
  }, ttl + 1000);
  timer.unref?.();
  return timer;
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
 *
 * Renewal also stops on its own at MAX_AUTO_RENEW_MS, so a caller that never
 * calls the returned function cannot hold the key indefinitely: the lock is
 * left to expire on its own TTL and the chat answers again.
 *
 * @param {string} key
 * @param {number} [ttl]
 * @param {number} [renewEveryMs]
 * @returns {() => void} stop function
 */
function startAutoRenew(key, ttl = DEFAULT_TTL_MS, renewEveryMs = Math.max(10_000, Math.floor(ttl / 3))) {
  const renewUntil = _now() + MAX_AUTO_RENEW_MS;
  const timer = setInterval(() => {
    if (_now() >= renewUntil) {
      clearInterval(timer);
      log.warn(`Auto-renew ceiling reached for ${key} after ${MAX_AUTO_RENEW_MS / 60_000} min: nobody released the lock, letting it expire`);
      return;
    }
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

export default { tryLock, refresh, startAutoRenew, unlock };
