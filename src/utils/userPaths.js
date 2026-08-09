// src/utils/userPaths.js
//
// Filesystem helpers for per-user storage.
//
// Layout:
//
//   data/
//     users/
//       <storageId>/                  ← chat history (WA jid/group, Discord thread id)
//         history/
//         history_meta.json
//       user_<sanitized>/             ← build workspaces (workspaceId user:…)
//       group_<sanitized>/            ← build workspaces (workspaceId group:…)
//
// Build trees live under user_* / group_* (see workspaceId.js, buildWorkspace.js).
// This module only manages <storageId>/ history paths.

import path from 'path';
import { DATA_DIR, PLATFORM_DISCORD, PLATFORM_WA_PERSONAL, isWhatsAppPlatform  } from '../config/constants.js';
import { getGroupTaskFileId  } from './userIdentifier.js';

/** Prefix for on-disk history of admin↔user personal-account chats (shared pair). */
const PERSONAL_CHAT_STORAGE_PREFIX = 'personal_';

// -- Storage ID resolution -------------------------------------------------

/**
 * Resolve the unique storageId used as the folder name under
 * data/users/<storageId>/ for chat history persistence.
 *
 *   - Discord thread: chatId (forum thread = shared conversation, like a WA group)
 *   - WhatsApp group: groupId
 *   - WA personal (admin↔user): personal_<chatId> (shared history for the pair)
 *   - WhatsApp DM (dedicated): waJid
 *
 * Discord author identity stays in userCtx.userId; only history files use chatId.
 *
 * Returns null when not resolvable.
 */
function resolvePersonalChatStorageId(chatId) {
  if (!chatId) return null;
  return PERSONAL_CHAT_STORAGE_PREFIX + String(chatId);
}

/** Persistent settings file id for a WA personal pair chat (shared by both users). */
function _resolvePersonalMemoryFileId(chatId) {
  const storageId = resolvePersonalChatStorageId(chatId);
  return storageId ? `memory_${storageId}` : null;
}

/**
 * Persisted settings file for a chat: per group, per personal-chat pair, or per
 * user. Discord keeps no settings, so it resolves to null.
 * @param {object} ctx - message context (platform, isGroup, groupId, chatId)
 * @param {{ taskFileId: string }} ui - resolved user identity
 * @returns {string|null}
 */
function resolveSettingsFileId(ctx, ui) {
  if (ctx.platform === PLATFORM_DISCORD) return null;
  if (ctx.isGroup && isWhatsAppPlatform(ctx.platform)) {
    return 'memory_' + getGroupTaskFileId(ctx.groupId);
  }
  if (ctx.platform === PLATFORM_WA_PERSONAL && ctx.chatId) return _resolvePersonalMemoryFileId(ctx.chatId);
  return 'memory_' + ui.taskFileId;
}

function resolveStorageId(userCtx) {
  if (!userCtx) return null;
  if (userCtx.platform === PLATFORM_DISCORD) {
    return userCtx.chatId ? String(userCtx.chatId) : null;
  }
  if (userCtx.platform === PLATFORM_WA_PERSONAL && userCtx.chatId) {
    return resolvePersonalChatStorageId(userCtx.chatId);
  }
  if (userCtx.isGroup) return userCtx.groupId ? String(userCtx.groupId) : null;
  if (userCtx.waJid) return String(userCtx.waJid);
  return null;
}

// -- Path helpers ----------------------------------------------------------

function getUserRoot(userCtx) {
  const id = resolveStorageId(userCtx);
  if (!id) return null;
  return path.join(DATA_DIR, 'users', id);
}

function getHistoryDir(userCtx) {
  const r = getUserRoot(userCtx);
  return r && path.join(r, 'history');
}

export default {
  resolvePersonalChatStorageId,
  resolveSettingsFileId,
  resolveStorageId,
  getUserRoot,
  getHistoryDir
};
