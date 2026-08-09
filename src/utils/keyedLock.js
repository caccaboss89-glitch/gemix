// src/utils/keyedLock.js
//
// Per-key async mutex, used wherever a read-modify-write on a per-user or
// per-file JSON store must not interleave with itself (chat history metadata,
// saved preferences, scheduled reminders).
//
// Each key holds the promise of the operation currently in flight; a new caller
// chains onto it, so operations on the same key run strictly in order while
// different keys stay independent. A rejected operation does not block the ones
// queued behind it, and the entry is dropped once the chain drains, so the map
// never grows past the number of keys being written right now.

/**
 * Run `fn` with exclusive access to `key`.
 *
 * @param {Map<string, Promise>} locks - Caller-owned map, one per store.
 * @param {string} key
 * @param {Function} fn - async () => T
 * @returns {Promise} Resolves/rejects with fn's own outcome.
 */
function withKeyedLock(locks, key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  // Run fn whether or not the previous holder succeeded: its failure is its
  // caller's problem, not a reason to skip this one.
  const current = prev.then(fn, fn);
  // What the next caller waits on never rejects, so one failure cannot poison
  // the queue behind it.
  const settled = current.then(() => {}, () => {});
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return current;
}

export { withKeyedLock 
};
