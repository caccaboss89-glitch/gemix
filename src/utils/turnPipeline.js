// Shared batch→history→handleMessage→deliver sequence for all platforms.

import responseLock from './responseLock.js';
import { pickLatestBatchEntry, filterBatchToTriggerSpeaker } from './batchContext.js';
import constants from '../config/constants.js';
import { handleMessage } from '../handler.js';

const { BATCH_LOCK_TTL_MS } = constants;

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
 * @param {string} opts.platform - resolves each entry's speaker key
 * @param {Function|null} opts.stopLockRenew
 * @param {Array} opts.entries - batch entries (narrowed to the trigger speaker)
 * @param {string} opts.discardLogLabel - chat id for discard warning
 * @param {Function} opts.loadHistory - async ({ entries, latest, first }) => { history, incomplete }
 *   (all current callers wrap utils/historyFetch.js's fetchHistoryWithTimeout, which already
 *   returns this normalized shape)
 * @param {Function} opts.buildHandlerCtx - ({ entries, history, latest, first }) => handler ctx
 * @param {Function} [opts.prepareSession] - async () => { stop?: Function } (typing/presence)
 * @param {Function} [opts.interceptTurn] - async ({ entries, latest, first }) =>
 *   { response, onDelivered?: Function } | null. A returned response becomes the whole
 *   turn: no history load, no media ingress, no AI call. onDelivered runs only once the
 *   response actually went out. Used by the WhatsApp privacy gate.
 * @param {Function} [opts.transformResponse] - (response, ctx) => response
 * @param {Function} opts.deliver - async (ctx, response) => void
 * @param {Function} [opts.onDeliverError] - async (ctx, err) => void
 */
async function runTurnPipeline(opts) {
  const {
    log,
    lockKey,
    platform,
    stopLockRenew,
    entries: firedEntries,
    discardLogLabel,
    loadHistory,
    buildHandlerCtx,
    prepareSession,
    interceptTurn,
    transformResponse,
    deliver,
    onDeliverError
  } = opts;

  /** Transform, send, and report whether it went out. @returns {Promise<boolean>} */
  const deliverTurn = async (ctx, response) => {
    let outgoing = response;
    if (typeof transformResponse === 'function') {
      outgoing = transformResponse(outgoing, ctx) || outgoing;
    }
    try {
      log.info('\nSending response...');
      await deliver(ctx, outgoing);
      log.info('   Message sent');
      return true;
    } catch (err) {
      log.error('\nError sending response:');
      log.error(`   ${err.message}`);
      if (typeof onDeliverError === 'function') {
        await onDeliverError(ctx, err);
      }
      return false;
    }
  };

  const { entries, dropped } = filterBatchToTriggerSpeaker(firedEntries, platform);
  if (dropped > 0) {
    log.info(`   Batch for ${discardLogLabel}: ignoring ${dropped} message(s) from other participants (not queued)`);
  }
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

    // Runs before anything reads the chat or fetches media, so a turn it answers
    // costs no history rebuild and no attachment download.
    if (typeof interceptTurn === 'function') {
      const intercepted = await interceptTurn({ entries, latest, first });
      if (intercepted) {
        const sent = await deliverTurn(null, intercepted.response);
        if (sent && typeof intercepted.onDelivered === 'function') {
          await intercepted.onDelivered();
        }
        return;
      }
    }

    const { history, incomplete: historyLoadIncomplete } = await loadHistory({ entries, latest, first });

    if (typeof prepareSession === 'function') {
      try {
        session = await prepareSession({ entries, latest, first });
      } catch { /* ignore */ }
    }

    let ctx = buildHandlerCtx({
      entries, history, historyLoadIncomplete, latest, first, session
    });
    if (ctx && typeof ctx.then === 'function') ctx = await ctx;
    const response = await handleMessage(ctx);

    await deliverTurn(ctx, response);
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

export { runTurnPipeline };
