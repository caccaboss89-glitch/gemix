const { ACTIVE_MEMBERS } = require('../config/members');

// Reference to WhatsApp dedicated client - set at runtime
let client = null;

// Cooldown tracking: prevent spamming admin with repeated errors
const cooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minuti per tipo di errore

function setAdminNotifierClient(waClient) {
  client = waClient;
}

/**
 * Send an error notification to the admin via WhatsApp.
 * Includes cooldown to avoid spam on repeated failures.
 * @param {string} source - Error source (e.g., 'AIMLAPI (Gemini)', 'SerpAPI')
 * @param {string} errorMessage - Error details
 */
async function notifyAdmin(source, errorMessage) {
  if (!client) return;

  const lastNotified = cooldowns.get(source) || 0;
  if (Date.now() - lastNotified < COOLDOWN_MS) return;
  cooldowns.set(source, Date.now());

  const admin = ACTIVE_MEMBERS.find(m => m.admin);
  if (!admin) return;

  const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const message = `⚠️ *ERRORE API — ${source}*\n\n${errorMessage}\n\n_${timestamp}_`;

  try {
    await client.sendMessage(admin.wa, message);
  } catch {
    // Silently fail — don't cause further errors
  }
}

module.exports = { setAdminNotifierClient, notifyAdmin };
