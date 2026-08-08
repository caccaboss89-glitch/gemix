// src/config/systemMessages.js
//
// Central registry of all GemiX-generated WhatsApp system messages.
// Every entry has two synced parts: the exact text sent + the regex used by
// isSystemMessage() to recognise a message as program-generated. History builders
// (whatsapp/shared.js, discord/client.js) render every match as a
// <system-notification> user turn instead of one of GemiX's own replies.
// Change one -> update the other. This is the single source of truth.

// -- Release notification --------------------------------------------------

/**
 * Prefix used in every new-release notification.
 * releaseMonitor.js constructs the full message as:
 *   `🚀 *Nuova release GemiX: ${title}*\n\n${cleanBody}`.trim()
 * The regex matches on the fixed prefix.
 */
const RELEASE_NOTIFICATION_PREFIX = '🚀 *Nuova release GemiX:';
const RELEASE_NOTIFICATION_REGEX  = /^\uD83D\uDE80 \*Nuova release GemiX:/;

// -- Music wrap ------------------------------------------------------------

/**
 * Music wrap monthly notification sent to all active members.
 * The full text is built dynamically (month name varies) so we match on prefix.
 */
const MUSIC_WRAP_PREFIX = '🎵 *Wrap di';
const MUSIC_WRAP_REGEX  = /^\uD83C\uDFB5 \*Wrap di /;

// -- Admin error notifications ---------------------------------------------

/**
 * Admin API error alert. Full text: `⚠️ *ERRORE API - ${source}*\n\n...` (em-dash in actual message)
 * The regex matches messages sent by adminNotifier.js.
 */
const ADMIN_ERROR_PREFIX = '⚠️ *ERRORE API —';
const ADMIN_ERROR_REGEX  = /^\u26A0\uFE0F \*ERRORE API \u2014/;

// -- Maintenance -----------------------------------------------------------

/**
 * Maintenance-mode message shown to non-admin users.
 * Defined in constants.js (MAINTENANCE_USER_MESSAGE) - matched here by prefix.
 */
const MAINTENANCE_PREFIX = '🌙 GemiX è temporaneamente in manutenzione';
const MAINTENANCE_REGEX  = /^\uD83C\uDF19 GemiX è temporaneamente in manutenzione/;

// -- Release-notify subscription confirmations -----------------------------

/**
 * Sent by handler.js when a user subscribes to release notifications during maintenance.
 */
const RELEASE_NOTIFY_ENABLED_PREFIX  = '🔔 Le notifiche degli aggiornamenti di GemiX sono state attivate.';
const RELEASE_NOTIFY_ENABLED_REGEX   = /^\uD83D\uDD14 Le notifiche degli aggiornamenti di GemiX/;

const RELEASE_NOTIFY_ALREADY_PREFIX  = 'ℹ️ Le notifiche degli aggiornamenti di GemiX sono già attive.';
const RELEASE_NOTIFY_ALREADY_REGEX   = /^\u2139\uFE0F Le notifiche degli aggiornamenti di GemiX/;

// -- Fallback Errors -------------------------------------------------------

const FALLBACK_ERROR_PREFIX = '⚠️ GemiX: Generazione della risposta fallita. Riprova tra poco.';
const FALLBACK_ERROR_REGEX  = /^\u26A0\uFE0F GemiX: Generazione della risposta fallita\./;

// -- Grok credit exhaustion (user-facing) -----------------------------------

/**
 * Shown to the user when xAI returns personal-team-blocked:spending-limit
 * (SuperGrok weekly credit cap). Built as a full message (not only a prefix)
 * so handler.js never hardcodes copy. Detection of the *error* is in
 * apiClient.isGrokCreditExhaustedError; this entry is for send + history tag.
 * Format mirrors adminNotifier admin-error lines for consistency.
 */
const GROK_CREDIT_EXHAUSTED_MESSAGE =
  '⚠️ *ERRORE API — API (Grok)*\n\nScusa ma i crediti sono finiti al momento, tornerò disponibile con il prossimo rinnovo settimanale di SuperGrok 💰💶';
const GROK_CREDIT_EXHAUSTED_REGEX =
  /^\u26A0\uFE0F \*ERRORE API \u2014 API \(Grok\)\*\n\nScusa ma i crediti sono finiti al momento/;

// -- Temporary attachment links --------------------------------------------

/**
 * System message indicating that some attachments couldn't be sent directly
 * and are available via temporary download links instead.
 * Dynamic expiry text is appended after this prefix (see attachmentFallback.js).
 * The regex matches on the fixed emoji prefix.
 */
const TEMP_ATTACHMENT_PREFIX = '📥 Allegat';
const TEMP_ATTACHMENT_REGEX  = /^\uD83D\uDCE5 Allegat/;

/**
 * Last-resort text when link fallback generation itself fails
 * (sendAttachmentsWithFallback catch).
 */
const ATTACHMENT_FALLBACK_FAILED_MESSAGE =
  '⚠️ I seguenti allegati non hanno potuto essere inviati e non è possibile creare un link di download temporaneo. Riprova più tardi.';
const ATTACHMENT_FALLBACK_FAILED_REGEX =
  /^\u26A0\uFE0F I seguenti allegati non hanno potuto essere inviati/;

// -- Privacy: first-contact notice and data wipe ---------------------------

/**
 * Command that empties the chat and erases every trace of the user from the
 * server. WhatsApp only, recognised only when it is the whole message, and it
 * never starts an AI call (see platforms/whatsapp/privacyGate.js).
 */
const PRIVACY_WIPE_COMMAND = '/clear';

/**
 * Sent instead of the AI turn the first time a person writes on WhatsApp, so
 * whatever they attached to that message is never downloaded before they have
 * been told what happens to it.
 */
const PRIVACY_NOTICE_PREFIX = '🔒 *Informativa privacy GemiX*';
const PRIVACY_NOTICE_REGEX  = /^🔒 \*Informativa privacy GemiX\*/;

/** Confirmation sent once PRIVACY_WIPE_COMMAND erased everything. */
const PRIVACY_WIPE_DONE_PREFIX = '🗑️ *Dati eliminati*';
const PRIVACY_WIPE_DONE_REGEX  = /^🗑️ \*Dati eliminati\*/;

/** Sent when the chat clear or one of the deletions failed. */
const PRIVACY_WIPE_FAILED_MESSAGE =
  '⚠️ *Eliminazione non riuscita*\n\nNon è stato possibile eliminare tutti i tuoi dati per un errore tecnico. '
  + 'Contatta l\'amministratore.';
const PRIVACY_WIPE_FAILED_REGEX = /^⚠️ \*Eliminazione non riuscita\*/;

/** Active members keep their registry entry: only the admin can remove it. */
const PRIVACY_MEMBER_CONTACT_NOTE =
  'Nome, numero e indirizzo email restano nel registro dei membri attivi: per rimuovere anche quelli, '
  + 'contatta l\'amministratore.';

/**
 * Full first-contact notice. Storage criteria are stated in words rather than
 * in figures so the copy cannot drift from the limits in constants.js (which
 * cannot be imported here: it is constants.js that imports this file).
 *
 * @param {{ isActiveMember?: boolean, hasAttachments?: boolean }} [opts]
 *   hasAttachments adds the reassurance about the files that came with this very
 *   message: it only makes sense when there were any.
 * @returns {string}
 */
function buildPrivacyNoticeMessage(opts = {}) {
  const lines = [
    PRIVACY_NOTICE_PREFIX,
    '',
    'È la prima volta che mi scrivi, quindi prima di risponderti ci tengo a dirti come vengono trattati i tuoi dati.',
    '',
    '- Le conversazioni restano sul server per darmi il contesto delle risposte, e l\'amministratore può '
    + 'potenzialmente accedere alle conversazioni complete.',
    '- Gli allegati restano sul server finché compaiono nella finestra di messaggi recenti che uso per '
    + 'rispondere: quando ne escono vengono eliminati, così come i file che genero, dopo qualche ora di inattività.',
    '- Non scrivermi mai dati sensibili, credenziali o informazioni private.',
  ];
  if (opts.hasAttachments) {
    lines.push('- Gli allegati che hai inviato insieme a questo primo messaggio non sono stati scaricati né salvati.');
  }
  lines.push(
    '',
    `Se continui a scrivere accetti queste condizioni. Se non le accetti, scrivi \`${PRIVACY_WIPE_COMMAND}\` da `
    + 'solo, senza altro testo: svuoto questa chat, cancello anche il messaggio che hai appena inviato ed elimino '
    + 'dal server tutti i tuoi dati — messaggi, allegati, trascrizioni dei miei vocali, preferenze, promemoria '
    + 'programmati e file generati. Puoi usarlo in qualunque momento.',
  );
  if (opts.isActiveMember) {
    lines.push('', PRIVACY_MEMBER_CONTACT_NOTE);
  }
  return lines.join('\n');
}

/**
 * Confirmation that the wipe succeeded.
 * @param {{ isActiveMember?: boolean }} [opts]
 * @returns {string}
 */
function buildPrivacyWipeDoneMessage(opts = {}) {
  const lines = [
    PRIVACY_WIPE_DONE_PREFIX,
    '',
    'Ho svuotato questa chat ed eliminato dal server tutti i tuoi dati: cronologia, allegati, trascrizioni dei '
    + 'miei messaggi vocali, preferenze salvate, promemoria programmati e file generati.',
  ];
  if (opts.isActiveMember) {
    lines.push('', PRIVACY_MEMBER_CONTACT_NOTE);
  }
  return lines.join('\n');
}

// -- Error / alert patterns ----------------------------------------------
// These regexes detect error, avviso, and reminder messages.
const LEGACY_ERROR_REGEX  = /^\u274C \*ERRORE/;   // ❌ *ERRORE
const LEGACY_AVVISO_REGEX = /^⚠️ \*AVVISO/;        // ⚠️ *AVVISO
const LEGACY_REMINDER_REGEX = /^🔔 \*Promemoria/;  // 🔔 *Promemoria

// -- Utility: ordered list of all system-message regexes -------------------
// Used by isSystemMessage() in shared.js for a single authoritative check.
const ALL_SYSTEM_MESSAGE_REGEXES = [
  RELEASE_NOTIFICATION_REGEX,
  MUSIC_WRAP_REGEX,
  ADMIN_ERROR_REGEX,
  MAINTENANCE_REGEX,
  RELEASE_NOTIFY_ENABLED_REGEX,
  RELEASE_NOTIFY_ALREADY_REGEX,
  FALLBACK_ERROR_REGEX,
  GROK_CREDIT_EXHAUSTED_REGEX,
  TEMP_ATTACHMENT_REGEX,
  ATTACHMENT_FALLBACK_FAILED_REGEX,
  PRIVACY_NOTICE_REGEX,
  PRIVACY_WIPE_DONE_REGEX,
  PRIVACY_WIPE_FAILED_REGEX,
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
  GROK_CREDIT_EXHAUSTED_MESSAGE,
  TEMP_ATTACHMENT_PREFIX,
  ATTACHMENT_FALLBACK_FAILED_MESSAGE,
  PRIVACY_WIPE_COMMAND,
  PRIVACY_NOTICE_PREFIX,
  PRIVACY_WIPE_DONE_PREFIX,
  PRIVACY_WIPE_FAILED_MESSAGE,
  buildPrivacyNoticeMessage,
  buildPrivacyWipeDoneMessage,
  // individual regexes (for targeted checks)
  RELEASE_NOTIFICATION_REGEX,
  MUSIC_WRAP_REGEX,
  ADMIN_ERROR_REGEX,
  MAINTENANCE_REGEX,
  RELEASE_NOTIFY_ENABLED_REGEX,
  RELEASE_NOTIFY_ALREADY_REGEX,
  FALLBACK_ERROR_REGEX,
  GROK_CREDIT_EXHAUSTED_REGEX,
  TEMP_ATTACHMENT_REGEX,
  ATTACHMENT_FALLBACK_FAILED_REGEX,
  PRIVACY_NOTICE_REGEX,
  PRIVACY_WIPE_DONE_REGEX,
  PRIVACY_WIPE_FAILED_REGEX,
  LEGACY_ERROR_REGEX,
  LEGACY_AVVISO_REGEX,
  LEGACY_REMINDER_REGEX,
  // canonical detector
  isSystemMessage,
};
