// src/utils/workspaceId.js
//
// Identifies the build workspace tied to a user/group context. Mirrors §2.2
// of Analisi_Pulizia_v2.md:
//
//   - WhatsApp group  → "group:<groupId>"
//     The whole group shares one workspace; any member of that group sees
//     the same files. Cross-platform link is impossible for groups since
//     groups only exist on WhatsApp.
//   - Anything else   → "user:<storageId>"
//     `storageId` is already cross-platform for active members (Discord
//     userId, WA dedicated, WA personal all collapse to the same id via
//     resolveStorageId), so a single workspace follows the user everywhere.
//
// The `group:` / `user:` prefix is purely for filesystem-safe disambiguation:
// we don't want a group whose id collides with a user storageId to share a
// workspace by accident.

const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { resolveStorageId } = require('./userPaths');

/**
 * Compute the canonical workspace identifier for the current request.
 * Returns null when neither a groupId nor a storageId can be resolved
 * (caller should fall back with an explicit error).
 */
function resolveWorkspaceId(ctx) {
  if (!ctx) return null;
  const isWhatsApp = typeof ctx.platform === 'string' && ctx.platform.startsWith('whatsapp');
  if (isWhatsApp && ctx.isGroup && ctx.groupId) {
    return `group:${ctx.groupId}`;
  }
  const storageId = resolveStorageId(ctx);
  if (storageId) return `user:${storageId}`;
  return null;
}

/**
 * Derive a filesystem-safe slug from a workspace id. Used both for the
 * on-disk workspace path and for docker container names.
 *
 *   group:393347468304-1234567890@g.us  →  group_393347468304-1234567890_at_g_us
 *   user:393347468304@c.us              →  user_393347468304_at_c_us
 *
 * Length is capped at 63 to fit Docker's container name limit.
 */
function workspaceIdToSlug(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.includes(':')) return null;
  const replaced = workspaceId
    .replace(/@/g, '_at_')
    .replace(/:/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return replaced.slice(0, 63);
}

/**
 * Resolve the on-disk path of a workspace.
 *
 *   data/users/<workspaceSlug>/build_workspace/
 *
 * The parent path (`data/users/<workspaceSlug>/`) is intentionally distinct
 * from the legacy per-user `data/users/<storageId>/` tree (different prefix
 * `group_`/`user_` ensures no collision) so legacy history/projects continue
 * to live where they always have.
 */
function getBuildWorkspacePath(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) return null;
  return path.join(DATA_DIR, 'users', slug, 'build_workspace');
}

/**
 * Get the parent directory used to store build-workspace metadata
 * (.activity.json, .lock, …) alongside the workspace tree itself.
 */
function getBuildWorkspaceMetaDir(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) return null;
  return path.join(DATA_DIR, 'users', slug);
}

module.exports = {
  resolveWorkspaceId,
  workspaceIdToSlug,
  getBuildWorkspacePath,
  getBuildWorkspaceMetaDir,
};
