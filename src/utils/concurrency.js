// src/utils/concurrency.js
//
// Bounded parallelism. mapWithConcurrency runs async work over a list while
// preserving input order in the results; history builders use it to prepare
// media concurrently without tying that generic ingress path to a provider.
// createSemaphore bounds work that arrives one piece at a time instead.

/**
 * Map `items` through async `fn` with at most `limit` concurrent calls.
 * Results are returned in the same order as `items`.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit - max concurrent invocations (>=1)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  let next = 0;

  async function worker() {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(max, list.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * A counting semaphore: at most `limit` holders at once, the others wait in
 * arrival order. A waiter whose signal aborts leaves the queue with the
 * signal's reason, so the caller's deadline also bounds its wait.
 *
 * @param {number} limit - max concurrent holders (>=1)
 * @returns {{ acquire: (signal?: AbortSignal) => Promise<() => void>,
 *   readonly active: number, readonly waiting: number }} `acquire` resolves to
 *   the release function; calling it more than once releases once
 */
function createSemaphore(limit) {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const waiters = [];
  let active = 0;

  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      // A queued waiter takes the slot over, so the holder count stays put.
      if (next) next();
      else active--;
    };
  };

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < max) {
      active++;
      return Promise.resolve(releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        waiters.splice(waiters.indexOf(grant), 1);
        reject(signal.reason);
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(releaser());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(grant);
    });
  }

  return {
    acquire,
    get active() { return active; },
    get waiting() { return waiters.length; }
  };
}

export { createSemaphore, mapWithConcurrency };
