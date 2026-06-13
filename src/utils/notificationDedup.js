// src/utils/notificationDedup.js
//
// Per-call intermediate notification dedup.
//
// GemiX can run multiple tool rounds within a single AI call. Without dedup,
// each round that triggers a slow operation (PDF transcription, video analysis,
// web research) would fire the same "please wait" banner repeatedly.
//
// This module tracks which (call, kind) pairs have already been notified and
// exposes the message builders for every notification kind.
//
// Usage pattern (handler.js):
//   ctx.requestId = <unique id generated once per handleMessage invocation>
//   markNotifiedInCall(ctx, 'video')  - true on first call, false on repeats
//   clearCallNotifications(ctx)       - called in the finally block of handleMessage

const { createLogger } = require('./logger');

const log = createLogger('NotificationDedup');

// Key: `${chatKey}:${requestId}:${kind}`
// Entries are removed by clearCallNotifications at the end of each AI call.
const _notified = new Set();

// -- Context key helpers ---------------------------------------------------

/**
 * Derive a stable chat-level key from a handler context.
 * Works for both the outer ctx (platform, chatId, ...) and userCtx (platform, chatId, ...).
 *
 * @param {object} ctx
 * @returns {string}
 */
function getChatKey(ctx) {
  if (!ctx) return 'unknown:unknown';
  if (ctx.platform === 'discord') return `discord:${ctx.chatId || 'unknown'}`;
  if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
    return `${ctx.platform}:${ctx.chatId || ctx.groupId || ctx.userId || 'unknown'}`;
  }
  return `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}`;
}

// -- Dedup API -------------------------------------------------------------

/**
 * Mark a notification kind as "already sent" for the current AI call.
 *
 * Returns true the first time a (call, kind) pair is seen - the caller should
 * send the message. Returns false on every subsequent call within the same AI
 * invocation - the caller should stay silent.
 *
 * @param {object} ctx  - Handler context; must have `requestId` set.
 * @param {string} kind - Notification kind: 'image_gen' | 'video_gen' | 'build' | etc.
 * @returns {boolean}
 */
function markNotifiedInCall(ctx, kind) {
  const callId = ctx?.requestId || ctx?.chatId || ctx?.userId || 'unknown';
  const key = `${getChatKey(ctx)}:${callId}:${kind}`;
  if (_notified.has(key)) return false;
  _notified.add(key);
  return true;
}

/**
 * Remove all dedup entries for the given AI call.
 * Must be called in the `finally` block of `handleMessage` so the next
 * independent call can fire notifications again.
 *
 * @param {object} ctx - Handler context; must have `requestId` set.
 */
function clearCallNotifications(ctx) {
  const callId = ctx?.requestId || ctx?.chatId || ctx?.userId || 'unknown';
  const prefix = `${getChatKey(ctx)}:${callId}:`;
  for (const key of _notified) {
    if (key.startsWith(prefix)) _notified.delete(key);
  }
}

// -- Message builders ------------------------------------------------------

/**
 * Fixed build notification. Sent BEFORE the build sub-agent is invoked,
 * so the user knows the host is delegating the task and is about to wait for
 * the deliverable. Dedup key 'build' ensures it fires once per AI call even
 * if the model invokes `build` multiple times.
 * @returns {string}
 */
function buildEngineeringNotificationMessage() {
  return '🛠️ Sto delegando il lavoro al coder agent, attendi un attimo...';
}

// -- Safety valve ----------------------------------------------------------
// The Set should stay tiny (one entry per active call × kind), but guard
// against leaks from calls that crash before clearCallNotifications runs.

const _cleanupTimer = setInterval(() => {
  if (_notified.size > 5000) {
    log.warn(`NotificationDedup Set grew to ${_notified.size}; clearing to prevent leak.`);
    _notified.clear();
  }
}, 2 * 60 * 1000);
_cleanupTimer.unref();

module.exports = {
  getChatKey,
  markNotifiedInCall,
  clearCallNotifications,
  buildEngineeringNotificationMessage,
};
