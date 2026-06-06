// src/tools/releaseNotify.js
//
// Manages per-chat subscription state for GemiX release notifications.
// Persists via systemState ('releases' key).
// Exposes isReleaseNotifyEnabled, toggleReleaseNotify, and getSubscribedChats
// for use by handler and admin flows. In-memory Map with disk backup.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const { get: getSystemState, update: updateSystemState } = require('../utils/systemState');

/** @type {Map<string, string>} chatId -> waJid (delivery target) */
let subscribedChats = new Map();

function _load() {
  const state = getSystemState('releases');
  if (state && state.subscriptions) {
    subscribedChats = new Map(Object.entries(state.subscriptions));
    return;
  }

  // Fallback: try loading from JSON file if systemState entry missing
  const OLD_FILE = path.join(DATA_DIR, 'releaseNotifyChats.json');
  if (fs.existsSync(OLD_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        subscribedChats = new Map(Object.entries(raw));
      }
    } catch { }
  }
}

async function _save() {
  await updateSystemState('releases', (current) => ({
    ...current,
    subscriptions: Object.fromEntries(subscribedChats)
  }));
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
  if (chatId && waJid) {
    return subscribedChats.get(chatId) === waJid;
  }
  if (chatId) return subscribedChats.has(chatId);
  return Boolean(_findByWaJid(waJid));
}

async function enableReleaseNotify(chatId, waJid) {
  if (!chatId || !waJid) {
    return { success: false, alreadyEnabled: false, error: 'Unable to determine the chat or WhatsApp number.' };
  }
  if (subscribedChats.get(chatId) === waJid) {
    return { success: true, alreadyEnabled: true, message: 'GemiX release notifications were already enabled for this chat.' };
  }
  for (const [existingChatId, existingWaJid] of [...subscribedChats.entries()]) {
    if (existingChatId === chatId || existingWaJid === waJid) {
      subscribedChats.delete(existingChatId);
    }
  }
  subscribedChats.set(chatId, waJid);
  await _save();
  return { success: true, alreadyEnabled: false, message: 'GemiX release notifications enabled for this chat.' };
}

/**
 * Toggle release notifications for a chat.
 * @param {boolean} enabled - Whether to enable or disable notifications
 * @param {string} chatId - Unique chat identifier
 * @param {string} waJid - WhatsApp JID where notifications will be delivered
 * @returns {string} Result message
 */
async function toggleReleaseNotify(enabled, chatId, waJid) {
  if (!chatId || !waJid) {
    return { success: false, error: 'Unable to determine the chat or WhatsApp number.' };
  }
  if (enabled) {
    return await enableReleaseNotify(chatId, waJid);
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
  await _save();
  return { success: true, message: 'GemiX release notifications disabled for this chat.' };
}

/**
 * Get all subscribed WA JIDs (deduplicated).
 * @returns {Map<string, string>} chatId -> waJid
 */
function getSubscribedChats() {
  return new Map(subscribedChats);
}

module.exports = { toggleReleaseNotify, getSubscribedChats, isReleaseNotifyEnabled, enableReleaseNotify };
