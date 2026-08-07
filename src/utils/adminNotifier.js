// src/utils/adminNotifier.js
//
// Forwards critical errors from the bot and the sandbox proxy to the
// administrator via WhatsApp. Uses a per-source cooldown.

const { ACTIVE_MEMBERS } = require('../config/members');

let client = null;

const cooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

// Standardized message suffix appended to AI tool errors after admin
// notification. Composed from shared halves so the bug_report variant (which
// must not tell the model off for calling bug_report) cannot drift from it.
const _NOTIFIED = 'Admin has been notified.';
const _EXPLAIN = 'In your final text response, explain the problem to the user and tell them the admin has already been notified.';
const ADMIN_NOTIFIED_SUFFIX = ` [${_NOTIFIED} DO NOT use bug_report for this error. ${_EXPLAIN}]`;
/** Same note for a bug_report that just succeeded — filing one is what it did. */
const ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT = ` [${_NOTIFIED} ${_EXPLAIN}]`;

/**
 * Set the WhatsApp dedicated client reference for admin notifications.
 * @param {object} waClient - The whatsapp-web.js Client instance
 */
function setAdminNotifierClient(waClient) {
  client = waClient;
}

/**
 * Send an error notification to the admin via WhatsApp.
 * Uses a per-source cooldown.
 * @param {string} source - Error source (e.g., 'API (Grok)', 'WhatsApp Delivery')
 * @param {string} errorMessage - Error details
 */
async function notifyAdmin(source, errorMessage) {
  if (!client) return;

  const lastNotified = cooldowns.get(source) || 0;
  if (Date.now() - lastNotified < COOLDOWN_MS) return;
  cooldowns.set(source, Date.now());

  const admin = ACTIVE_MEMBERS.find(m => m.admin);
  if (!admin) return;

  const { ADMIN_ERROR_PREFIX } = require('../config/systemMessages'); // dynamic require for system message prefixes
  const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const message = `${ADMIN_ERROR_PREFIX} ${source}*\n\n${errorMessage}\n\n_${timestamp}_`;

  try {
    await client.sendMessage(admin.wa, message);
  } catch {
    // Ignore send errors
  }
}

module.exports = {
  setAdminNotifierClient,
  notifyAdmin,
  ADMIN_NOTIFIED_SUFFIX,
  ADMIN_NOTIFIED_SUFFIX_AFTER_REPORT,
};
