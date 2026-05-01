// src/config/systemMessages.js
// Centralised registry of all GemiX-generated WhatsApp system messages.
//
// IMPORTANT: every entry here has TWO parts that must stay in sync:
//   text(...)  — the actual message text sent to WhatsApp
//   regex      — a RegExp used by _isSystemMessage() in shared.js to detect
//                that message in history and label it as "[System]".
//
// If you change the text of a message, update its regex accordingly,
// and vice versa. Both live here so you never forget to do both.

// ── Release notification ──────────────────────────────────────────────────────

/**
 * Prefix used in every new-release notification.
 * releaseMonitor.js constructs the full message as:
 *   `🚀 *Nuova release GemiX: ${title}*\n\n${cleanBody}`.trim()
 * The regex matches on the fixed prefix.
 */
const RELEASE_NOTIFICATION_PREFIX = '🚀 *Nuova release GemiX:';
const RELEASE_NOTIFICATION_REGEX  = /^\uD83D\uDE80 \*Nuova release GemiX:/;

// ── Music wrap ────────────────────────────────────────────────────────────────

/**
 * Music wrap monthly notification sent to all active members.
 * The full text is built dynamically (month name varies) so we match on prefix.
 */
const MUSIC_WRAP_PREFIX = '🎵 *Wrap di';
const MUSIC_WRAP_REGEX  = /^\uD83C\uDFB5 \*Wrap di /;

// ── Admin error notifications ─────────────────────────────────────────────────

/**
 * Admin API error alert. Full text: `⚠️ *ERRORE API — ${source}*\n\n…`
 * The regex matches messages sent by adminNotifier.js.
 */
const ADMIN_ERROR_PREFIX = '⚠️ *ERRORE API —';
const ADMIN_ERROR_REGEX  = /^\u26A0\uFE0F \*ERRORE API \u2014/;

// ── Maintenance ───────────────────────────────────────────────────────────────

/**
 * Maintenance-mode message shown to non-admin users.
 * Defined in constants.js (MAINTENANCE_USER_MESSAGE) — matched here by prefix.
 */
const MAINTENANCE_PREFIX = '🌙 GemiX è temporaneamente in manutenzione';
const MAINTENANCE_REGEX  = /^\uD83C\uDF19 GemiX è temporaneamente in manutenzione/;

// ── Release-notify subscription confirmations ─────────────────────────────────

/**
 * Sent by handler.js when a user subscribes to release notifications during maintenance.
 */
const RELEASE_NOTIFY_ENABLED_PREFIX  = '🔔 Le notifiche degli aggiornamenti di GemiX sono state attivate.';
const RELEASE_NOTIFY_ENABLED_REGEX   = /^\uD83D\uDD14 Le notifiche degli aggiornamenti di GemiX/;

const RELEASE_NOTIFY_ALREADY_PREFIX  = 'ℹ️ Le notifiche degli aggiornamenti di GemiX sono già attive.';
const RELEASE_NOTIFY_ALREADY_REGEX   = /^\u2139\uFE0F Le notifiche degli aggiornamenti di GemiX/;

// ── Fallback Errors ───────────────────────────────────────────────────────────

const FALLBACK_ERROR_PREFIX = '⚠️ GemiX: Generazione della risposta fallita. Riprova tra poco.';
const FALLBACK_ERROR_REGEX  = /^\u26A0\uFE0F GemiX: Generazione della risposta fallita\./;

// ── Legacy error / alert patterns (kept for backward compatibility) ──────────
// These match older message formats that may still exist in history.
const LEGACY_ERROR_REGEX  = /^\u274C \*ERRORE/;   // ❌ *ERRORE
const LEGACY_AVVISO_REGEX = /^⚠️ \*AVVISO/;        // ⚠️ *AVVISO
const LEGACY_REMINDER_REGEX = /^🔔 \*Promemoria/;  // 🔔 *Promemoria

// ── Utility: ordered list of all system-message regexes ──────────────────────
// Used by isSystemMessage() in shared.js for a single authoritative check.
const ALL_SYSTEM_MESSAGE_REGEXES = [
  RELEASE_NOTIFICATION_REGEX,
  MUSIC_WRAP_REGEX,
  ADMIN_ERROR_REGEX,
  MAINTENANCE_REGEX,
  RELEASE_NOTIFY_ENABLED_REGEX,
  RELEASE_NOTIFY_ALREADY_REGEX,
  FALLBACK_ERROR_REGEX,
  LEGACY_ERROR_REGEX,
  LEGACY_AVVISO_REGEX,
  LEGACY_REMINDER_REGEX,
];

/**
 * Returns true if `body` matches any known GemiX-generated system message.
 * Use this as the single source of truth for system-message detection.
 * @param {string} body
 * @returns {boolean}
 */
function isSystemMessage(body) {
  if (!body) return false;
  return ALL_SYSTEM_MESSAGE_REGEXES.some(rx => rx.test(body));
}

module.exports = {
  // text helpers (for sending)
  RELEASE_NOTIFICATION_PREFIX,
  MUSIC_WRAP_PREFIX,
  ADMIN_ERROR_PREFIX,
  MAINTENANCE_PREFIX,
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX,
  // individual regexes (for targeted checks)
  RELEASE_NOTIFICATION_REGEX,
  MUSIC_WRAP_REGEX,
  ADMIN_ERROR_REGEX,
  MAINTENANCE_REGEX,
  RELEASE_NOTIFY_ENABLED_REGEX,
  RELEASE_NOTIFY_ALREADY_REGEX,
  FALLBACK_ERROR_REGEX,
  LEGACY_ERROR_REGEX,
  LEGACY_AVVISO_REGEX,
  LEGACY_REMINDER_REGEX,
  // canonical detector
  isSystemMessage,
};
