// src/utils/concurrency.js
//
// Small helper to run async work over a list with bounded parallelism while
// preserving input order in the results. Used to upload history attachments
// to xAI in parallel (instead of one-by-one) so building the turn context
// stays fast and does not blow the history-fetch timeout.

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

module.exports = { mapWithConcurrency };
