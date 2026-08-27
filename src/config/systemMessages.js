// src/config/systemMessages.js
//
// Central registry of all GemiX-generated WhatsApp system messages.
//
// Every message is declared once, as the literal prefix that opens it, and
// listed in SYSTEM_MESSAGE_PREFIXES. isSystemMessage() recognises a
// program-generated message by matching those prefixes against the start of the
// body, so adding a message here is the only step needed — there is no second,
// hand-synced pattern to keep in step. History builders (whatsapp/shared.js,
// discord/client.js) render every match as a <system-notification> user turn
// instead of one of GemiX's own replies.

// -- Release notification --------------------------------------------------

/**
 * Prefix used in every new-release notification.
 * releaseMonitor.js constructs the full message as:
 *   `🚀 *Nuova release GemiX: ${title}*\n\n${cleanBody}`.trim()
 */
const RELEASE_NOTIFICATION_PREFIX = '🚀 *Nuova release GemiX:';

// -- Music wrap ------------------------------------------------------------

/** Music wrap monthly notification sent to all active members (the month varies). */
const MUSIC_WRAP_PREFIX = '🎵 *Wrap di';

// -- Admin operational alerts ----------------------------------------------

/** Operational alert from adminNotifier.js: `⚠️ *ERRORE GEMIX — ${source}*\n\n...`. */
const ADMIN_ERROR_PREFIX = '⚠️ *ERRORE GEMIX —';

// -- Maintenance -----------------------------------------------------------

/**
 * Maintenance-mode message shown to non-admin users.
 * Defined in constants.js (MAINTENANCE_USER_MESSAGE) - matched here by prefix.
 */
const MAINTENANCE_PREFIX = '🌙 GemiX è temporaneamente in manutenzione';

// -- Release-notify subscription confirmations -----------------------------

/**
 * Sent by handler.js when a user subscribes to release notifications during maintenance.
 */
const RELEASE_NOTIFY_ENABLED_PREFIX = '🔔 Le notifiche degli aggiornamenti di GemiX sono state attivate.';
const RELEASE_NOTIFY_ALREADY_PREFIX = 'ℹ️ Le notifiche degli aggiornamenti di GemiX sono già attive.';

// -- Fallback Errors -------------------------------------------------------

const FALLBACK_ERROR_PREFIX = '⚠️ GemiX: Generazione della risposta fallita. Riprova tra poco.';

// -- Slow media-tool progress ----------------------------------------------

/** Program-owned progress banners sent before long image/video generation. */
const IMAGE_GENERATION_PROGRESS_PREFIX = '🎨 Sto generando l\'immagine';
const VIDEO_GENERATION_PROGRESS_PREFIX = '🎬 Sto generando il video';

// -- Provider refusals (user-facing) ----------------------------------------

/**
 * Shown when xAI reports the SuperGrok allowance is spent. It names the plan and
 * its weekly renewal, so it may only ever answer a QUOTA failure that really
 * came from the xAI profile — ai/providers/errorPolicy.js decides that on the
 * error's kind and the active profile, never on the wording of a message.
 * Its dedicated prefix makes it a system message without classifying a quota
 * refusal as an administrator alert.
 */
const GROK_CREDIT_EXHAUSTED_PREFIX = '⚠️ *LIMITE MODELLO — Grok*';
const GROK_CREDIT_EXHAUSTED_MESSAGE =
  `${GROK_CREDIT_EXHAUSTED_PREFIX}\n\nScusa ma i crediti sono finiti al momento, `
  + 'tornerò disponibile con il prossimo rinnovo settimanale di SuperGrok 💰💶';

/**
 * The same situation on any other profile. It names no provider and no plan:
 * the user cannot act on which backend GemiX runs, and a message that said
 * "SuperGrok" elsewhere would simply be wrong.
 */
const PROVIDER_LIMIT_PREFIX = '⚠️ *LIMITE MODELLO*';
const PROVIDER_LIMIT_MESSAGE =
  `${PROVIDER_LIMIT_PREFIX}\n\nHo esaurito la disponibilità del modello per il momento. `
  + 'Riprova più tardi.';

/** Credentials the deployment has to fix: no delivery claim is made here. */
const PROVIDER_AUTH_PREFIX = '⚠️ *ERRORE MODELLO — autenticazione*';
const PROVIDER_AUTH_MESSAGE =
  `${PROVIDER_AUTH_PREFIX}\n\nNon riesco ad autenticarmi con il modello in questo momento. `
  + 'Il problema richiede un intervento dell\'amministratore.';

// -- Sandbox capacity ------------------------------------------------------

/**
 * Sent when every sandbox slot is taken and this chat would need a new one.
 * GemiX runs a fixed number of workspace containers (the ceiling lives in
 * constants.js, which cannot be named here: it is constants.js that imports
 * this file). A chat that already holds one is never turned away; every new
 * workspace, including an administrator's, shares the same global ceiling.
 */
const SANDBOX_BUSY_PREFIX = '⚙️ GemiX è sotto utilizzo intensivo al momento';
const SANDBOX_BUSY_MESSAGE =
  `${SANDBOX_BUSY_PREFIX}: non ho un posto libero per aprire il tuo spazio di lavoro. `
  + 'Riprova tra qualche minuto.';

// -- Temporary attachment links --------------------------------------------

/**
 * System message indicating that some attachments couldn't be sent directly
 * and are available via temporary download links instead.
 * Dynamic expiry text is appended after this prefix (see attachmentFallback.js).
 */
const TEMP_ATTACHMENT_PREFIX = '📥 Allegat';

/**
 * Last-resort text when link fallback generation itself fails
 * (sendAttachmentsWithFallback catch).
 */
const ATTACHMENT_FALLBACK_FAILED_MESSAGE =
  '⚠️ I seguenti allegati non hanno potuto essere inviati e non è possibile creare un link di download temporaneo. Riprova più tardi.';

// -- Privacy: first-contact notice and data wipe ---------------------------

/**
 * Command that empties the chat and deletes the conversation data GemiX stores
 * on its server. WhatsApp only, recognised only when it is the whole message,
 * and it never starts an AI call (see platforms/whatsapp/privacyGate.js).
 */
const PRIVACY_WIPE_COMMAND = '/clear';

/**
 * Sent instead of the AI turn the first time a person writes on WhatsApp, so
 * whatever they attached to that message is never downloaded before they have
 * been told what happens to it.
 */
const PRIVACY_NOTICE_PREFIX = '🔒 *Informativa privacy GemiX*';

/** Confirmation sent once PRIVACY_WIPE_COMMAND erased everything. */
const PRIVACY_WIPE_DONE_PREFIX = '🗑️ *Dati eliminati*';

/** Sent when the chat clear or one of the deletions failed. */
const PRIVACY_WIPE_FAILED_MESSAGE =
  '⚠️ *Eliminazione non riuscita*\n\nNon è stato possibile eliminare tutti i tuoi dati per un errore tecnico. '
  + 'Contatta l\'amministratore.';

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
    '- Le richieste e risposte complete scambiate con il provider AI possono restare nei log diagnostici per un '
    + 'massimo di 30 giorni; il comando di eliminazione qui sotto rimuove anche quelle associate a questa chat.',
    '- Non scrivermi mai dati sensibili, credenziali o informazioni private.'
  ];
  if (opts.hasAttachments) {
    lines.push('- Gli allegati che hai inviato insieme a questo primo messaggio non sono stati scaricati né salvati.');
  }
  lines.push(
    '',
    `Se continui a scrivere accetti queste condizioni. Se non le accetti, scrivi \`${PRIVACY_WIPE_COMMAND}\` da `
    + 'solo, senza altro testo: svuoto questa chat, cancello anche il messaggio che hai appena inviato ed elimino '
    + 'dal server i dati che GemiX conserva per questa chat — messaggi, allegati, trascrizioni dei miei vocali, '
    + 'preferenze, promemoria, file generati e log API diagnostici. Non può ritirare messaggi o segnalazioni già '
    + 'consegnati fuori dalla chat. Puoi usarlo in qualunque momento.'
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
    'Ho svuotato questa chat ed eliminato dal server i dati che GemiX conservava per questa chat: cronologia, '
    + 'allegati, trascrizioni dei miei messaggi vocali, preferenze salvate, promemoria, file generati e log API diagnostici.'
  ];
  if (opts.isActiveMember) {
    lines.push('', PRIVACY_MEMBER_CONTACT_NOTE);
  }
  return lines.join('\n');
}

// -- Detection -------------------------------------------------------------

/** Every message GemiX still sends. Add a new one here and detection follows. */
const SYSTEM_MESSAGE_PREFIXES = [
  RELEASE_NOTIFICATION_PREFIX,
  MUSIC_WRAP_PREFIX,
  ADMIN_ERROR_PREFIX,
  GROK_CREDIT_EXHAUSTED_PREFIX,
  PROVIDER_LIMIT_PREFIX,
  PROVIDER_AUTH_PREFIX,
  MAINTENANCE_PREFIX,
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX,
  IMAGE_GENERATION_PROGRESS_PREFIX,
  VIDEO_GENERATION_PROGRESS_PREFIX,
  SANDBOX_BUSY_PREFIX,
  TEMP_ATTACHMENT_PREFIX,
  ATTACHMENT_FALLBACK_FAILED_MESSAGE,
  PRIVACY_NOTICE_PREFIX,
  PRIVACY_WIPE_DONE_PREFIX,
  PRIVACY_WIPE_FAILED_MESSAGE
];

/**
 * Shapes GemiX no longer produces, still sitting in old chat history. Kept so a
 * rebuilt window classifies them as program notices rather than as GemiX's own
 * replies; safe to drop once no live chat reaches back that far.
 */
const LEGACY_SYSTEM_MESSAGE_PREFIXES = [
  '⚠️ *ERRORE API —',
  '❌ *ERRORE',
  '⚠️ *AVVISO',
  '🔔 *Promemoria'
];

/**
 * Returns true if `body` starts with any known GemiX-generated system message.
 * Use this as the single source of truth for system-message detection.
 * @param {string} body
 * @returns {boolean}
 */
function isSystemMessage(body) {
  if (typeof body !== 'string' || !body) return false;
  return SYSTEM_MESSAGE_PREFIXES.some(p => body.startsWith(p))
    || LEGACY_SYSTEM_MESSAGE_PREFIXES.some(p => body.startsWith(p));
}

export {
  RELEASE_NOTIFICATION_PREFIX,
  MUSIC_WRAP_PREFIX,
  ADMIN_ERROR_PREFIX,
  MAINTENANCE_PREFIX,
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX,
  IMAGE_GENERATION_PROGRESS_PREFIX,
  VIDEO_GENERATION_PROGRESS_PREFIX,
  SANDBOX_BUSY_MESSAGE,
  SANDBOX_BUSY_PREFIX,
  GROK_CREDIT_EXHAUSTED_PREFIX,
  GROK_CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_LIMIT_PREFIX,
  PROVIDER_LIMIT_MESSAGE,
  PROVIDER_AUTH_PREFIX,
  PROVIDER_AUTH_MESSAGE,
  TEMP_ATTACHMENT_PREFIX,
  ATTACHMENT_FALLBACK_FAILED_MESSAGE,
  PRIVACY_WIPE_COMMAND,
  PRIVACY_WIPE_FAILED_MESSAGE,
  buildPrivacyNoticeMessage,
  buildPrivacyWipeDoneMessage,
  isSystemMessage
};
