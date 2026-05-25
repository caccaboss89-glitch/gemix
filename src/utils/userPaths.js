// src/utils/userPaths.js
//
// Filesystem helpers for per-user storage.
//
// Layout (post-cleanup):
//
//   data/
//     skills/                         ← read-only skill scripts (PDF/DOCX/XLSX/PPTX)
//     users/
//       <storageId>/                  ← legacy per-user tree (chat history)
//         history/
//         voice_counts.json
//       user_<sanitized>/             ← build sub-agent workspaces (workspaceId)
//       group_<sanitized>/              .build_state.json + build_workspace/
//
// The legacy `projects/`, `searched_images/`, `scratch/` folders that lived
// under <storageId>/ are gone — the agentic project system was retired in
// favour of the build sub-agent (Analisi_Pulizia_v2.md §4).
//
// Anything under `user_<…>/` / `group_<…>/` is owned by the build subsystem
// (see utils/workspaceId.js, sandbox/buildWorkspace.js, utils/buildState.js)
// and not touched by this module.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, PLATFORM_DISCORD } = require('../config/constants');

const SKILLS_DIR = path.join(DATA_DIR, 'skills');

// ── Storage ID resolution ──────────────────────────────────────────────────

/**
 * Resolve the unique storageId used as the user's folder name under
 * data/users/<storageId>/ for chat history persistence.
 *
 *   - Discord:        userId (Discord account ID)
 *   - WhatsApp group: groupId
 *   - WhatsApp DM:    waJid
 *
 * Returns null when not resolvable.
 */
function resolveStorageId(userCtx) {
  if (!userCtx) return null;
  if (userCtx.platform === PLATFORM_DISCORD) {
    return userCtx.userId ? String(userCtx.userId) : null;
  }
  if (userCtx.isGroup && userCtx.groupId) return String(userCtx.groupId);
  if (userCtx.waJid) return String(userCtx.waJid);
  return null;
}

// ── Path helpers ───────────────────────────────────────────────────────────

function getUserRoot(userCtx) {
  const id = resolveStorageId(userCtx);
  if (!id) return null;
  return path.join(DATA_DIR, 'users', id);
}

function getHistoryDir(userCtx) {
  const r = getUserRoot(userCtx);
  return r && path.join(r, 'history');
}

// ── Skeleton creation ──────────────────────────────────────────────────────

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Create the per-user folders if missing. Idempotent.
 *
 * Just history now — every other zone the bot writes (voice counts,
 * build workspace) materializes its own dirs on demand.
 */
function ensureUserSkeleton(userCtx) {
  const root = getUserRoot(userCtx);
  if (!root) return false;
  ensureDir(root);
  ensureDir(getHistoryDir(userCtx));
  return true;
}

// ── Recursive size accounting (used by historySync diagnostics) ───────────

function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* skip */ }
    }
  }
  return total;
}

module.exports = {
  resolveStorageId,
  getUserRoot,
  getHistoryDir,
  ensureUserSkeleton,
  dirSizeBytes,
  SKILLS_DIR,
};
