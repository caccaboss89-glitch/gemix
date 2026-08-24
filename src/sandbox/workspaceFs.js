// src/sandbox/workspaceFs.js
//
// Host-side filesystem for the agent's two roots.
//
// Per-conversation layout under data/users/<workspaceSlug>/ :
//   build_workspace/        <- /workspace, writable by the agent
//   attachments/            <- /attachments, read-only projection
//   .build_state.json       <- activity timestamp (see utils/workspaceState.js)
//   .workspace_lock/        <- atomic mutation mutex (utils/workspaceState.js)
//
// Directory metadata and quota accounting run here. File bytes cross the host
// through hostFileGateway.js, while model-authored writes and shell commands
// run in the container.
//
// Quota: constants.WORKSPACE_QUOTA_MB over the workspace tree. The attachment
// projection is not the agent's to fill, so it does not count against it.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getAttachmentsPath, getWorkspacePath } from '../utils/workspaceId.js';
import { createLogger } from '../utils/logger.js';
import { listAgentDirectory } from './hostFileGateway.js';

const log = createLogger('WorkspaceFs');

const QUOTA_BYTES = constants.WORKSPACE_QUOTA_MB * 1024 * 1024;

/**
 * Ensure the workspace directory exists for `workspaceId`. Returns the
 * absolute path, or null if the workspaceId can't be resolved.
 */
function ensureWorkspace(workspaceId) {
  const dir = getWorkspacePath(workspaceId);
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { log.warn(`mkdir ${dir}: ${err.message}`); return null; }
  return dir;
}

/**
 * Ensure the attachment projection root exists. The container mounts it
 * read-only, and docker refuses to start when a bind source is missing, so it
 * has to exist even while the projection itself is empty.
 */
function ensureAttachmentsDir(workspaceId) {
  const dir = getAttachmentsPath(workspaceId);
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { log.warn(`mkdir ${dir}: ${err.message}`); return null; }
  return dir;
}

/**
 * UID/GID the workspace container should use so bind-mounted files are
 * owned by the same user as the Node process (host reads and projection).
 */
function hostSandboxIds() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  return { uid, gid };
}

/** Docker `User` string for container create / exec (fallback 1000:1000 off Linux). */
function sandboxUserString() {
  const { uid, gid } = hostSandboxIds();
  if (uid === null || uid === undefined || gid === null || gid === undefined) return '1000:1000';
  return `${uid}:${gid}`;
}

/**
 * Make the app-owned workspace root writable. Files below it are created by
 * the container with the same UID/GID as Node and need no recursive repair.
 * Avoiding a recursive chmod also means model-created symlinks are never
 * traversed by a privileged host operation.
 */
function ensureWorkspaceWritable(workspaceId) {
  const root = getWorkspacePath(workspaceId);
  if (!root || !fs.existsSync(root)) return;
  if (process.platform !== 'linux') return;

  const { uid, gid } = hostSandboxIds();
  if (uid === null || uid === undefined || gid === null || gid === undefined) return;

  const isRoot = process.getuid && process.getuid() === 0;
  let st;
  try { st = fs.lstatSync(root); }
  catch { return; }
  if (!st.isDirectory() || st.isSymbolicLink()) return;

  try {
    if (isRoot && (st.uid !== uid || st.gid !== gid)) fs.chownSync(root, uid, gid);
    if (isRoot || st.uid === uid) fs.chmodSync(root, 0o777);
  } catch (err) {
    log.warn(`ensureWorkspaceWritable ${root}: ${err.message}`);
  }
}

/** Recursive size in bytes of the workspace tree. */
function workspaceSizeBytes(workspaceId) {
  return listAgentDirectory(workspaceId, 'workspace/', { limit: 1 })?.totalBytes || 0;
}

/**
 * Quota state of the workspace, for the Runtime block and post-write checks.
 * @returns {{ usedBytes: number, quotaBytes: number, overBy: number }}
 */
function workspaceQuotaState(workspaceId) {
  const usedBytes = workspaceSizeBytes(workspaceId);
  return { usedBytes, quotaBytes: QUOTA_BYTES, overBy: Math.max(0, usedBytes - QUOTA_BYTES) };
}

/**
 * Report quota state after a mutation. API writes are rejected by
 * assertWorkspaceCapacity before they begin; the container quota monitor stops
 * shell processes that cross the aggregate cap while still allowing cleanup.
 *
 * @param {string} workspaceId
 * @returns {{ ok: boolean, usedBytes: number, quotaBytes: number, message: string|null }}
 */
function checkWorkspaceQuota(workspaceId) {
  const { usedBytes, quotaBytes, overBy } = workspaceQuotaState(workspaceId);
  if (overBy === 0) return { ok: true, usedBytes, quotaBytes, message: null };
  return {
    ok: false,
    usedBytes,
    quotaBytes,
    message: `Workspace is over its ${constants.WORKSPACE_QUOTA_MB} MB quota `
      + `(${Math.round(usedBytes / (1024 * 1024))} MB used). Delete files you no longer need before writing more.`
  };
}

function assertWorkspaceCapacity(workspaceId, incomingBytes, replacedBytes = 0) {
  const sizeAfter = workspaceSizeBytes(workspaceId) - Math.max(0, replacedBytes) + Math.max(0, incomingBytes);
  if (sizeAfter <= QUOTA_BYTES) return;
  const err = new Error(`Workspace quota would be exceeded (${constants.WORKSPACE_QUOTA_MB} MB cap).`);
  err.code = 'EQUOTA';
  throw err;
}

/**
 * Wipe everything inside the workspace, leaving the root dir intact.
 * Used by the TTL sweeper. The state file lives one level up (in the meta
 * dir), so it is NOT touched here.
 */
function wipeWorkspace(workspaceId) {
  const root = getWorkspacePath(workspaceId);
  if (!root || !fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (err) { log.warn(`wipeWorkspace readdir: ${err.message}`); return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    try {
      if (e.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    } catch (err) { log.warn(`wipeWorkspace failed on ${full}: ${err.message}`); }
  }
}

export {
  QUOTA_BYTES,
  ensureWorkspace,
  ensureAttachmentsDir,
  ensureWorkspaceWritable,
  sandboxUserString,
  workspaceSizeBytes,
  workspaceQuotaState,
  checkWorkspaceQuota,
  assertWorkspaceCapacity,
  wipeWorkspace
};
