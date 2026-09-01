// Atomic batch start: avoids race between hasPendingBatch and tryLock.
//
// While GemiX is answering, new messages are NOT queued for a follow-up turn
// (intentional). Only messages that arrive during the short debounce window
// before the lock is taken are merged into the same batch. One that arrives
// later is handed to utils/liveInbox.js instead, so the turn already running
// can still read it mid-flight, and it returns as an ordinary user turn in the
// next turn's history.

import { pushMessage, hasPendingBatch, peekPendingBatchLastEntry  } from './messageBatcher.js';
import responseLock from './responseLock.js';
import { recordLiveMessage } from './liveInbox.js';

import constants from '../config/constants.js';

function _wrapBatchHandler(batchKey, handler, log, discardLogLabel) {
  return async (entries) => {
    if (!responseLock.refresh(batchKey, constants.BATCH_LOCK_TTL_MS)) {
      if (!responseLock.tryLock(batchKey, constants.BATCH_LOCK_TTL_MS)) {
        if (log && typeof log.warn === 'function') {
          log.warn(`   Batch handler skipped for ${discardLogLabel}: lock not held (not queued)`);
        }
        return;
      }
    }
    return handler(entries);
  };
}

/**
 * Enqueue an incoming message for debounced batching, or start a new batch with lock.
 *
 * @param {object} opts
 * @param {Function} [opts.describeLiveMessage] - () => { userName, text, timestampMs, hasMedia }.
 *   Called only when the message misses the batch, to hand it to the running
 *   turn as a mid-turn note. The adapter supplies it because only it knows how
 *   to read its own platform's message.
 * @returns {'batched'|'started'|'live'} live = lock held, so the message goes to
 *   the running turn's inbox instead of starting one
 */
function enqueueBatchedTurn({ batchKey, entry, handler, log, discardLogLabel, describeLiveMessage }) {
  const wrappedHandler = _wrapBatchHandler(batchKey, handler, log, discardLogLabel);
  if (hasPendingBatch(batchKey)) {
    pushMessage(batchKey, entry, wrappedHandler);
    return 'batched';
  }
  if (!responseLock.tryLock(batchKey, constants.BATCH_LOCK_TTL_MS)) {
    const held = typeof describeLiveMessage === 'function'
      ? recordLiveMessage(batchKey, describeLiveMessage())
      : 0;
    if (log && typeof log.warn === 'function') {
      log.warn(
        `   Not starting a turn for ${discardLogLabel}: GemiX is already responding`
        + (held > 0 ? ` (message ${held} handed to the running turn)` : ' (message not queued)')
      );
    }
    return 'live';
  }
  const stopLockRenew = responseLock.startAutoRenew(batchKey, constants.BATCH_LOCK_TTL_MS);
  pushMessage(batchKey, { ...entry, stopLockRenew }, wrappedHandler);
  return 'started';
}

export {
  enqueueBatchedTurn,
  peekPendingBatchLastEntry
};