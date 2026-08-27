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

import { get as getSystemState, update as updateSystemState } from '../utils/systemState.js';

/** @type {Map<string, string>} chatId -> waJid (delivery target) */
let subscribedChats = new Map();

function _load() {
  const state = getSystemState('releases');
  if (state && state.subscriptions) {
    subscribedChats = new Map(Object.entries(state.subscriptions));
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

/** Whether this chat currently has release notifications enabled. */
function isReleaseNotifySubscribed(chatId) {
  return Boolean(chatId) && subscribedChats.has(chatId);
}

export { toggleReleaseNotify, getSubscribedChats, enableReleaseNotify, isReleaseNotifySubscribed
};
