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

function _findByWaJid(waJid) {
  if (!waJid) return null;
  for (const [chatId, storedWaJid] of subscribedChats.entries()) {
    if (storedWaJid === waJid) return { chatId, waJid: storedWaJid };
  }
  return null;
}

function isReleaseNotifyEnabled(chatId, waJid) {
  if (!chatId && !waJid) return false;
  if (chatId && subscribedChats.has(chatId)) return true;
  return Boolean(_findByWaJid(waJid));
}

function enableReleaseNotify(chatId, waJid) {
  if (!chatId || !waJid) {
    return { success: false, alreadyEnabled: false, error: 'Unable to determine the chat or WhatsApp number.' };
  }
  if (isReleaseNotifyEnabled(chatId, waJid)) {
    return { success: true, alreadyEnabled: true, message: 'GemiX release notifications were already enabled for this chat.' };
  }
  for (const [existingChatId, existingWaJid] of subscribedChats.entries()) {
    if (existingChatId === chatId || existingWaJid === waJid) {
      subscribedChats.delete(existingChatId);
    }
  }
  subscribedChats.set(chatId, waJid);
  _save();
  return { success: true, alreadyEnabled: false, message: 'GemiX release notifications enabled for this chat.' };
}

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
    return enableReleaseNotify(chatId, waJid);
  }
  let removed = false;
  if (subscribedChats.has(chatId)) {
    subscribedChats.delete(chatId);
    removed = true;
  }
  for (const [existingChatId, existingWaJid] of [...subscribedChats.entries()]) {
    if (existingWaJid === waJid) {
      subscribedChats.delete(existingChatId);
      removed = true;
    }
  }
  if (!removed) {
    return { success: true, message: 'Release notifications were already disabled for this chat.' };
  }
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

module.exports = { toggleReleaseNotify, getSubscribedChats, isReleaseNotifyEnabled, enableReleaseNotify };
