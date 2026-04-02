const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const STATE_FILE = path.join(DATA_DIR, 'releaseNotifyChats.json');

/** @type {Map<string, string>} chatId → waJid (delivery target) */
let subscribedChats = new Map();

function _load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      subscribedChats = new Map(Object.entries(raw));
    }
  } catch {}
}

function _save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(subscribedChats), null, 2), 'utf-8');
}

_load();

/**
 * Toggle release notifications for a chat.
 * @param {boolean} enabled - Whether to enable or disable notifications
 * @param {string} chatId - Unique chat identifier
 * @param {string} waJid - WhatsApp JID where notifications will be delivered
 * @returns {string} Result message
 */
function toggleReleaseNotify(enabled, chatId, waJid) {
  if (!chatId || !waJid) {
    return '❌ Impossibile determinare la chat o il numero WhatsApp.';
  }
  if (enabled) {
    subscribedChats.set(chatId, waJid);
    _save();
    return '✅ Notifiche nuove release GemiX attivate per questa chat.';
  }
  if (!subscribedChats.has(chatId)) {
    return 'ℹ️ Le notifiche release erano già disattivate per questa chat.';
  }
  subscribedChats.delete(chatId);
  _save();
  return '✅ Notifiche nuove release GemiX disattivate per questa chat.';
}

/**
 * Get all subscribed WA JIDs (deduplicated).
 * @returns {Map<string, string>} chatId → waJid
 */
function getSubscribedChats() {
  return new Map(subscribedChats);
}

module.exports = { toggleReleaseNotify, getSubscribedChats };
