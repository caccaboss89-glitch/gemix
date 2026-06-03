// Shared batch→history→handleMessage→deliver sequence for all platforms.

const responseLock = require('./responseLock');
const { pickLatestBatchEntry } = require('./batchContext');
const { normalizeHistoryLoad } = require('./historyFetch');

const { BATCH_LOCK_TTL_MS } = require('../config/constants');

/** Keep or re-acquire the per-chat lock before running a batched turn. */
function _ensurePipelineLock(lockKey, stopLockRenew) {
  if (responseLock.refresh(lockKey, BATCH_LOCK_TTL_MS)) {
    return stopLockRenew || responseLock.startAutoRenew(lockKey, BATCH_LOCK_TTL_MS);
  }
  if (responseLock.tryLock(lockKey, BATCH_LOCK_TTL_MS)) {
    return responseLock.startAutoRenew(lockKey, BATCH_LOCK_TTL_MS);
  }
  return null;
}

/**
 * Run one debounced turn after the batcher fires.
 *
 * @param {object} opts
 * @param {object} opts.log - logger
 * @param {string} opts.lockKey
 * @param {Function|null} opts.stopLockRenew
 * @param {Array} opts.entries - batch entries
 * @param {string} opts.discardLogLabel - chat id for discard warning
 * @param {Function} opts.loadHistory - async ({ entries, latest, first }) => history array
 * @param {Function} opts.buildHandlerCtx - ({ entries, history, latest, first }) => handler ctx
 * @param {Function} [opts.prepareSession] - async () => { stop?: Function } (typing/presence)
 * @param {Function} [opts.transformResponse] - (response, ctx) => response
 * @param {Function} opts.deliver - async (ctx, response) => void
 * @param {Function} [opts.onDeliverError] - async (ctx, err) => void
 */
async function runTurnPipeline(opts) {
  const {
    log,
    lockKey,
    stopLockRenew,
    entries,
    discardLogLabel,
    loadHistory,
    buildHandlerCtx,
    prepareSession,
    transformResponse,
    deliver,
    onDeliverError,
  } = opts;

  const first = entries[0];
  const latest = pickLatestBatchEntry(entries) || first;

  let activeStopRenew = stopLockRenew;
  let session = null;
  let pipelineOwnsLock = false;
  try {
    activeStopRenew = _ensurePipelineLock(lockKey, activeStopRenew);
    if (!activeStopRenew) {
      try { if (typeof stopLockRenew === 'function') stopLockRenew(); } catch { }
      // Intentional: while a turn is in flight, new messages are discarded (not queued).
      log.warn(`   Batch discarded for ${discardLogLabel}: GemiX is already responding (not queued)`);
      return;
    }
    pipelineOwnsLock = true;

    const historyPayload = await loadHistory({ entries, latest, first });
    const { history, incomplete: historyLoadIncomplete } = normalizeHistoryLoad(historyPayload);

    if (typeof prepareSession === 'function') {
      try {
        session = await prepareSession({ entries, latest, first });
      } catch { /* ignore */ }
    }

    let ctx = buildHandlerCtx({
      entries, history, historyLoadIncomplete, latest, first, session,
    });
    if (ctx && typeof ctx.then === 'function') ctx = await ctx;
    const { handleMessage } = require('../handler');
    let response = await handleMessage(ctx);

    if (typeof transformResponse === 'function') {
      response = transformResponse(response, ctx) || response;
    }

    try {
      log.info('\nSending response...');
      await deliver(ctx, response);
      log.info('   Message sent');
    } catch (err) {
      log.error('\nError sending response:');
      log.error(`   ${err.message}`);
      if (typeof onDeliverError === 'function') {
        await onDeliverError(ctx, err);
      }
    }
  } finally {
    try { if (typeof stopLockRenew === 'function') stopLockRenew(); } catch { }
    try {
      if (typeof activeStopRenew === 'function' && activeStopRenew !== stopLockRenew) activeStopRenew();
    } catch { }
    if (pipelineOwnsLock) {
      try { responseLock.unlock(lockKey); } catch { }
    }
    try {
      if (session && typeof session.stop === 'function') await session.stop();
    } catch { }
  }
}

/** Merge multimodal parts from all batch entries into handler content. */
function mergeBatchContentParts(entries) {
  const allParts = [];
  for (const entry of entries) {
    if (Array.isArray(entry.contentParts)) {
      allParts.push(...entry.contentParts);
    }
  }
  if (allParts.length === 1 && allParts[0].type === 'text') {
    return allParts[0].text;
  }
  return allParts;
}

module.exports = { runTurnPipeline, mergeBatchContentParts };