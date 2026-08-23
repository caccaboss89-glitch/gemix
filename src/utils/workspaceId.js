// src/utils/workspaceId.js
//
// Computes the canonical workspace identifier for the agent runtime
// based on the current user/group context:
//
//   - WhatsApp group  - "group:<groupId>"  (shared workspace for the whole group)
//   - WA personal     - "group:personal:<chatId>" (admin↔user pair, shared build tree)
//   - WA dedicated DM - "user:<waJid>" (true 1:1 with GemiX)
//
// The `group:` / `user:` prefix provides filesystem-safe disambiguation.

import path from 'path';
import constants from '../config/constants.js';
import { resolveStorageId  } from './userPaths.js';

/**
 * Compute the canonical workspace identifier for the current request.
 * Returns null when neither a groupId nor a storageId can be resolved
 * (caller should fall back with an explicit error).
 */
function resolveWorkspaceId(ctx) {
  if (!ctx) return null;
  const isWhatsApp = constants.isWhatsAppPlatform(ctx.platform);
  if (isWhatsApp && ctx.isGroup && ctx.groupId) {
    return `group:${ctx.groupId}`;
  }
  if (ctx.platform === constants.PLATFORM_WA_PERSONAL) {
    return ctx.chatId ? `group:personal:${ctx.chatId}` : null;
  }
  const storageId = resolveStorageId(ctx);
  if (storageId) return `user:${storageId}`;
  return null;
}

/**
 * Derive a filesystem-safe slug from a workspace id. Used both for the
 * on-disk workspace path and for docker container names.
 *
 *   group:391234567890-1234567890@g.us  ->  group_391234567890-1234567890_at_g.us
 *   user:390000000000@c.us              ->  user_390000000000_at_c.us
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
 * Resolve the on-disk path of the agent's writable workspace.
 *
 *   data/users/<workspaceSlug>/build_workspace/   ->  /workspace in the container
 *
 * The directory name is historical and kept so an existing deployment does not
 * lose its workspace on upgrade. The parent path (`data/users/<workspaceSlug>/`)
 * is intentionally distinct from the legacy per-user `data/users/<storageId>/`
 * tree (different prefix `group_`/`user_` ensures no collision) so legacy
 * history/projects continue to live where they always have.
 */
function getWorkspacePath(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) return null;
  return path.join(constants.DATA_DIR, 'users', slug, 'build_workspace');
}

/**
 * Resolve the on-disk root of the read-only attachment projection.
 *
 *   data/users/<workspaceSlug>/attachments/   ->  /attachments in the container
 *
 * The projection itself (which conversation files land here, and when they are
 * pruned) is the attachment layer's job; this only names the directory.
 */
function getAttachmentsPath(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) return null;
  return path.join(constants.DATA_DIR, 'users', slug, 'attachments');
}

/**
 * Get the parent directory used to store workspace metadata
 * (activity timestamp, lock) alongside the workspace tree itself.
 */
function getWorkspaceMetaDir(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) return null;
  return path.join(constants.DATA_DIR, 'users', slug);
}

export {
  resolveWorkspaceId,
  workspaceIdToSlug,
  getWorkspacePath,
  getAttachmentsPath,
  getWorkspaceMetaDir

};
