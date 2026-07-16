// src/utils/messageBatcher.js
// Debounce-based message batcher: accumulates rapid-fire messages from the
// same chat into a single batch before triggering the AI handler. This solves
// the multi-file problem where each attachment arrives as a separate WhatsApp/
// Discord message and the first one would immediately trigger a response
// before the rest arrive.

const { createLogger } = require('./logger');

const log = createLogger('Batcher');

// -- Configuration --

const DEBOUNCE_MS = 2500;          // wait this long after the last message before firing
const MAX_WAIT_MS = 8000;          // absolute max wait from first message (prevents infinite delay)
const MAX_BATCH_SIZE = 15;         // hard cap on messages per batch (safety valve)

// -- State --

// Map<chatKey, { messages: Array, timer: NodeJS.Timeout|null, maxTimer: NodeJS.Timeout|null, handler: Function }>
const _batches = new Map();

/**
 * Push a message into the batcher. If no batch exists for the key, one is
 * created. The handler callback is invoked once the debounce window closes
 * or MAX_WAIT_MS elapses, whichever comes first.
 *
 * @param {string} key         Unique chat key (e.g. "wa_dedicated:<chatId>")
 * @param {object} entry       { ctx, contentParts } - raw pieces that the caller will merge
 * @param {Function} handler   async (mergedEntries: Array) => void - called with all entries
 */
function pushMessage(key, entry, handler) {
  let batch = _batches.get(key);

  if (!batch) {
    batch = { messages: [], timer: null, maxTimer: null, handler };
    _batches.set(key, batch);

    // Absolute ceiling: fire no matter what after MAX_WAIT_MS
    batch.maxTimer = setTimeout(() => _fire(key), MAX_WAIT_MS);
    if (batch.maxTimer.unref) batch.maxTimer.unref();
  }

  batch.messages.push(entry);

  // Safety cap
  if (batch.messages.length >= MAX_BATCH_SIZE) {
    _fire(key);
    return;
  }

  // Reset debounce timer
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => _fire(key), DEBOUNCE_MS);
  if (batch.timer.unref) batch.timer.unref();
}

/**
 * Fire the batch: call the handler with all accumulated messages then clean up.
 */
function _fire(key) {
  const batch = _batches.get(key);
  if (!batch) return;

  // Cleanup
  if (batch.timer) clearTimeout(batch.timer);
  if (batch.maxTimer) clearTimeout(batch.maxTimer);
  _batches.delete(key);

  const count = batch.messages.length;
  if (count > 1) {
    log.info(`   Batch fired for ${key}: ${count} message(s) (debounce window)`);
  }

  // Invoke handler (fire-and-forget; errors are the caller's responsibility)
  batch.handler(batch.messages).catch(err => {
    log.error(`Batcher handler error for ${key}: ${err.message}`);
  });
}

/**
 * Check if a batch is currently accumulating for the given key.
 * Useful so the caller can skip the response lock check for subsequent
 * messages that should be batched rather than discarded.
 */
function hasPendingBatch(key) {
  return _batches.has(key);
}

/**
 * Last entry already queued for an open batch (oldest→newest array).
 * Used to accept WA album continuations (caption-less media) without re-gating.
 * @param {string} key
 * @returns {object|null}
 */
function peekPendingBatchLastEntry(key) {
  const batch = _batches.get(key);
  if (!batch || !Array.isArray(batch.messages) || batch.messages.length === 0) return null;
  return batch.messages[batch.messages.length - 1];
}

module.exports = { pushMessage, hasPendingBatch, peekPendingBatchLastEntry };
