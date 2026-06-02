// src/utils/userPaths.js
//
// Filesystem helpers for per-user storage.
//
// Layout:
//
//   data/
//     skills/                         ← read-only skill scripts (PDF/DOCX/XLSX/PPTX)
//     users/
//       <storageId>/                  ← chat history (WA jid/group, Discord thread id)
//         history/
//         voice_counts.json
//       user_<sanitized>/             ← build workspaces (workspaceId user:…)
//       group_<sanitized>/             ← build workspaces (workspaceId group:…)
//
// Build trees live under user_* / group_* (see workspaceId.js, buildWorkspace.js).
// This module only manages <storageId>/ history and voice_counts.json.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, PLATFORM_DISCORD, PLATFORM_WA_PERSONAL } = require('../config/constants');

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
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

/** Long-term memory file id for a WA personal pair chat (shared by both users). */
function resolvePersonalMemoryFileId(chatId) {
  const storageId = resolvePersonalChatStorageId(chatId);
  return storageId ? `memory_${storageId}` : null;
}

function resolveStorageId(userCtx) {
  if (!userCtx) return null;
  if (userCtx.platform === PLATFORM_DISCORD) {
    return userCtx.chatId ? String(userCtx.chatId) : null;
  }
  if (userCtx.platform === PLATFORM_WA_PERSONAL && userCtx.chatId) {
    return resolvePersonalChatStorageId(userCtx.chatId);
  }
  if (userCtx.isGroup && userCtx.groupId) return String(userCtx.groupId);
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

// -- Skeleton creation -----------------------------------------------------

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Create the per-user folders if missing. Idempotent.
 *
 * Just history now - every other zone the bot writes (voice counts,
 * build workspace) materializes its own dirs on demand.
 */
function ensureUserSkeleton(userCtx) {
  const root = getUserRoot(userCtx);
  if (!root) return false;
  ensureDir(root);
  ensureDir(getHistoryDir(userCtx));
  return true;
}

module.exports = {
  resolvePersonalChatStorageId,
  resolvePersonalMemoryFileId,
  resolveStorageId,
  getUserRoot,
  getHistoryDir,
  ensureUserSkeleton,
  SKILLS_DIR,
  PERSONAL_CHAT_STORAGE_PREFIX,
};
