// src/tools/releaseNotify.js
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
  } catch { }
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
    return { success: false, error: 'Unable to determine the chat or WhatsApp number.' };
  }
  if (enabled) {
    subscribedChats.set(chatId, waJid);
    _save();
    return { success: true, message: 'GemiX release notifications enabled for this chat.' };
  }
  if (!subscribedChats.has(chatId)) {
    return { success: true, message: 'Release notifications were already disabled for this chat.' };
  }
  subscribedChats.delete(chatId);
  _save();
  return { success: true, message: 'GemiX release notifications disabled for this chat.' };
}

/**
 * Get all subscribed WA JIDs (deduplicated).
 * @returns {Map<string, string>} chatId → waJid
 */
function getSubscribedChats() {
  return new Map(subscribedChats);
}

module.exports = { toggleReleaseNotify, getSubscribedChats };
