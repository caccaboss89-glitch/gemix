// src/utils/pdfTranscriptionTracker.js
//
// Tracks concurrent PDF transcriptions per chat so that:
//   1. The "transcribing N document(s)" notification uses the correct count.
//   2. The notification is sent at most once per AI call (dedup via notificationDedup).
//
// Used exclusively by media.js → transcribeDocumentsInMessageContent.
// All other notification kinds (video, research) go through notificationDedup directly.

const { createLogger } = require('./logger');
const { markNotifiedInCall, buildPdfNotificationMessage, getChatKey } = require('./notificationDedup');

const log = createLogger('PdfTranscriptionTracker');

// Map: chatKey → { count: number, startTime: number }
// Tracks how many PDF parts are currently being transcribed for a given chat.
const _active = new Map();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Call before starting a PDF transcription.
 * Returns whether the caller should fire the intermediate notification.
 *
 * @param {object} ctx - Handler context (must have `requestId` set)
 * @returns {{ count: number, shouldNotify: boolean }}
 */
function incrementTranscription(ctx) {
  const key = getChatKey(ctx);
  const entry = _active.get(key) || { count: 0, startTime: Date.now() };
  entry.count++;
  _active.set(key, entry);

  // Dedup: only notify once per (call, kind='pdf').
  const shouldNotify = markNotifiedInCall(ctx, 'pdf');

  log.debug(`PDF transcription started for ${key}: count=${entry.count}, shouldNotify=${shouldNotify}`);
  return { count: entry.count, shouldNotify };
}

/**
 * Call after a PDF transcription completes (success or failure).
 *
 * @param {object} ctx - Handler context
 * @returns {{ count: number, isLast: boolean }}
 */
function decrementTranscription(ctx) {
  const key = getChatKey(ctx);
  const entry = _active.get(key);
  if (!entry) return { count: 0, isLast: false };

  entry.count--;
  const isLast = entry.count <= 0;
  if (isLast) {
    _active.delete(key);
  } else {
    _active.set(key, entry);
  }

  log.debug(`PDF transcription finished for ${key}: count=${entry.count}, isLast=${isLast}`);
  return { count: entry.count, isLast };
}

/**
 * Build the "transcribing N document(s)" notification message.
 * Kept as `buildNotificationMessage` for backward compatibility with media.js.
 *
 * @param {number} count
 * @returns {string}
 */
const buildNotificationMessage = buildPdfNotificationMessage;

// ── Stale-entry cleanup ─────────────────────────────────────────────────────
// Guard against entries that were never decremented (e.g. process crash mid-transcription).

const _STALE_THRESHOLD_MS = 5 * 60 * 1000;
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _active.entries()) {
    if (now - entry.startTime > _STALE_THRESHOLD_MS) {
      log.warn(`Removing stale PDF transcription entry for ${key}`);
      _active.delete(key);
    }
  }
}, 2 * 60 * 1000);
_cleanupTimer.unref();

module.exports = {
  incrementTranscription,
  decrementTranscription,
  buildNotificationMessage,
};
