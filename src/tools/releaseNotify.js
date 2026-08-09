// src/tools/releaseNotify.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Manages per-chat subscription state for GemiX release notifications.
// Persists via systemState ('releases' key).
// Exposes toggleReleaseNotify, enableReleaseNotify, and getSubscribedChats
// for use by handler and admin flows. In-memory Map with disk backup.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { get as getSystemState, update as updateSystemState } from '../utils/systemState.js';

/** @type {Map<string, string>} chatId -> waJid (delivery target) */
let subscribedChats = new Map();

function _load() {
  const state = getSystemState('releases');
  if (state && state.subscriptions) {
    subscribedChats = new Map(Object.entries(state.subscriptions));
    return;
  }

  // Fallback: try loading from JSON file if systemState entry missing
  const OLD_FILE = path.join(constants.DATA_DIR, 'releaseNotifyChats.json');
  if (fs.existsSync(OLD_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        subscribedChats = new Map(Object.entries(raw));
        // Migrate into systemState immediately so subscriptions are not RAM-only.
        _save().catch(() => { /* best-effort; next enable/toggle will retry */ });
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
 * @returns {Promise<{success: boolean, message?: string, error?: string, alreadyEnabled?: boolean}>}
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

export { toggleReleaseNotify, getSubscribedChats, enableReleaseNotify 
};
