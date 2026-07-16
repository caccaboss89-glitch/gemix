// Atomic batch start: avoids race between hasPendingBatch and tryLock.
//
// While GemiX is answering, new messages are NOT queued for a follow-up turn:
// they are discarded (intentional). Only messages that arrive during the short
// debounce window before the lock is taken are merged into the same batch.

const { pushMessage, hasPendingBatch, peekPendingBatchLastEntry } = require('./messageBatcher');
const responseLock = require('./responseLock');

const { BATCH_LOCK_TTL_MS } = require('../config/constants');

function _wrapBatchHandler(batchKey, handler, log, discardLogLabel) {
  return async (entries) => {
    if (!responseLock.refresh(batchKey, BATCH_LOCK_TTL_MS)) {
      if (!responseLock.tryLock(batchKey, BATCH_LOCK_TTL_MS)) {
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
 * @returns {'batched'|'started'|'discarded'} discarded = lock held, message ignored (no queue)
 */
function enqueueBatchedTurn({ batchKey, entry, handler, log, discardLogLabel }) {
  const wrappedHandler = _wrapBatchHandler(batchKey, handler, log, discardLogLabel);
  if (hasPendingBatch(batchKey)) {
    pushMessage(batchKey, entry, wrappedHandler);
    return 'batched';
  }
  if (!responseLock.tryLock(batchKey, BATCH_LOCK_TTL_MS)) {
    if (log && typeof log.warn === 'function') {
      log.warn(`   Ignoring message for ${discardLogLabel}: GemiX is already responding (not queued)`);
    }
    return 'discarded';
  }
  const stopLockRenew = responseLock.startAutoRenew(batchKey, BATCH_LOCK_TTL_MS);
  pushMessage(batchKey, { ...entry, stopLockRenew }, wrappedHandler);
  return 'started';
}

module.exports = {
  enqueueBatchedTurn,
  hasPendingBatch,
  peekPendingBatchLastEntry,
};