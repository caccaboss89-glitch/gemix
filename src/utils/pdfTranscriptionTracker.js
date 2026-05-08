// src/utils/pdfTranscriptionTracker.js
/**
 * Tracks active PDF transcriptions to avoid spamming notification messages.
 * Used to send dynamic "transcribing X document(s)" messages.
 */

const { createLogger } = require('./logger');

const log = createLogger('PdfTranscriptionTracker');

// Map: chatKey -> { count: number, notified: boolean, startTime: number }
const activeTranscriptions = new Map();

/**
 * Get a unique key for the chat/user context.
 * @param {object} ctx - Handler context
 * @returns {string} Unique key
 */
function getChatKey(ctx) {
  if (ctx.platform === 'discord') {
    return `discord:${ctx.chatId}`;
  }
  if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
    return `${ctx.platform}:${ctx.chatId || ctx.groupId || ctx.userId}`;
  }
  return `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}`;
}

/**
 * Increment transcription count for a chat.
 * @param {object} ctx - Handler context
 * @returns {object} { count, isFirst, shouldNotify }
 */
function incrementTranscription(ctx) {
  const key = getChatKey(ctx);
  const current = activeTranscriptions.get(key) || { count: 0, notified: false, startTime: Date.now() };
  current.count++;
  activeTranscriptions.set(key, current);
  
  const isFirst = current.count === 1;
  const shouldNotify = isFirst && !current.notified;
  
  if (shouldNotify) {
    current.notified = true;
  }
  
  log.debug(`Incremented transcription for ${key}: count=${current.count}, isFirst=${isFirst}, shouldNotify=${shouldNotify}`);
  
  return { count: current.count, isFirst, shouldNotify };
}

/**
 * Decrement transcription count for a chat.
 * @param {object} ctx - Handler context
 * @returns {object} { count, isLast }
 */
function decrementTranscription(ctx) {
  const key = getChatKey(ctx);
  const current = activeTranscriptions.get(key);
  
  if (!current) {
    return { count: 0, isLast: false };
  }
  
  current.count--;
  const isLast = current.count <= 0;
  
  if (isLast) {
    activeTranscriptions.delete(key);
  } else {
    activeTranscriptions.set(key, current);
  }
  
  log.debug(`Decremented transcription for ${key}: count=${current.count}, isLast=${isLast}`);
  
  return { count: current.count, isLast };
}

/**
 * Get current transcription count for a chat.
 * @param {object} ctx - Handler context
 * @returns {number} Current count
 */
function getTranscriptionCount(ctx) {
  const key = getChatKey(ctx);
  const current = activeTranscriptions.get(key);
  return current ? current.count : 0;
}

/**
 * Build a dynamic transcription notification message.
 * @param {number} count - Number of documents being transcribed
 * @returns {string} Message text
 */
function buildNotificationMessage(count) {
  if (count === 1) {
    return '⏳ Sto trascrivendo il documento, attendi un attimo...';
  }
  return `⏳ Sto trascrivendo ${count} documenti, attendi un attimo...`;
}

/**
 * Clean up stale entries (older than 5 minutes).
 * Called periodically to prevent memory leaks.
 */
function cleanupStaleEntries() {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  
  for (const [key, data] of activeTranscriptions.entries()) {
    if (now - data.startTime > staleThreshold) {
      log.warn(`Cleaning up stale transcription entry for ${key}`);
      activeTranscriptions.delete(key);
    }
  }
}

// Cleanup stale entries every 2 minutes
setInterval(cleanupStaleEntries, 2 * 60 * 1000);

module.exports = {
  incrementTranscription,
  decrementTranscription,
  getTranscriptionCount,
  buildNotificationMessage,
  getChatKey,
};
