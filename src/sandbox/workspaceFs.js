// src/sandbox/workspaceFs.js
//
// Host-side filesystem for the agent's roots.
//
// Per-conversation layout under data/users/<workspaceSlug>/ :
//   build_workspace/        <- /workspace, writable by the agent
//   attachments/            <- /attachments, read-only projection
//   .build_state.json       <- activity timestamp (see utils/workspaceState.js)
//   .workspace_lock/        <- atomic mutation mutex (utils/workspaceState.js)
//
// Plus one directory shared by every conversation:
//   <repo>/skills/          <- /skills, the shared skill library, read-only
//
// Directory metadata and quota accounting run here. File bytes cross the host
// through hostFileGateway.js, while model-authored writes and shell commands
// run in the container.
//
// Quota: one cap per writable root, over that root's own tree. The attachment
// projection is not the agent's to fill, so it does not count against either.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getAttachmentsPath, getWorkspacePath } from '../utils/workspaceId.js';
import { createLogger } from '../utils/logger.js';
import { listAgentDirectory } from './hostFileGateway.js';
import { ROOT, WRITABLE_ROOTS, toDisplayPath } from './workspacePaths.js';

const log = createLogger('WorkspaceFs');

/** Megabyte cap of each writable root. A root without one cannot be written. */
const ROOT_QUOTA_MB = Object.freeze({
  [ROOT.WORKSPACE]: constants.WORKSPACE_QUOTA_MB
});

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
 * Ensure the skill library exists. Shared by every conversation and mounted
 * read-only, so like the projection root it has to be there before docker
 * starts a container, even on a deployment that ships no skill at all.
 */
function ensureSkillsDir() {
  const dir = constants.SKILLS_DIR;
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

/** Megabyte cap of one writable root; throws for a root nothing may write to. */
function rootQuotaMb(root) {
  const quotaMb = ROOT_QUOTA_MB[root];
  if (!quotaMb) throw new Error(`No quota is defined for the "${root}" root.`);
  return quotaMb;
}

/** Recursive size in bytes of one writable root's tree. */
function _rootSizeBytes(workspaceId, root) {
  return listAgentDirectory(workspaceId, toDisplayPath(root, ''), { limit: 1 })?.totalBytes || 0;
}

/**
 * Report quota state of one root after a mutation. API writes are rejected by
 * assertRootCapacity before they begin; the container quota monitor stops
 * shell processes that cross a root's aggregate cap while still allowing cleanup.
 *
 * @param {string} workspaceId
 * @param {string} [root] - namespace root the mutation wrote to
 * @returns {{ ok: boolean, root: string, usedBytes: number, quotaBytes: number,
 *   quotaMb: number, message: string|null }}
 */
function checkRootQuota(workspaceId, root = ROOT.WORKSPACE) {
  const quotaMb = rootQuotaMb(root);
  const quotaBytes = quotaMb * 1024 * 1024;
  const usedBytes = _rootSizeBytes(workspaceId, root);
  if (usedBytes <= quotaBytes) {
    return { ok: true, root, usedBytes, quotaBytes, quotaMb, message: null };
  }
  return {
    ok: false,
    root,
    usedBytes,
    quotaBytes,
    quotaMb,
    message: `${toDisplayPath(root, '')} is over its ${constants.formatSizeLabel(quotaMb)} quota `
      + `(${constants.formatSizeLabel(usedBytes / (1024 * 1024))} used). Delete files you no longer need before writing more.`
  };
}

/**
 * The first writable root left over its cap, or the last root's ok state.
 * `shell` runs commands that can grow either root, so it checks them all
 * rather than guessing which one a command line touched.
 *
 * @param {string} workspaceId
 * @returns {ReturnType<typeof checkRootQuota>}
 */
function checkWritableQuotas(workspaceId) {
  let state = null;
  for (const root of WRITABLE_ROOTS) {
    state = checkRootQuota(workspaceId, root);
    if (!state.ok) return state;
  }
  return state;
}

/**
 * Refuse a write that would push one root past its cap, before it starts.
 * @param {string} workspaceId
 * @param {number} incomingBytes
 * @param {number} [replacedBytes] - bytes the write overwrites in place
 * @param {string} [root] - namespace root being written to
 */
function assertRootCapacity(workspaceId, incomingBytes, replacedBytes = 0, root = ROOT.WORKSPACE) {
  const quotaMb = rootQuotaMb(root);
  const sizeAfter = _rootSizeBytes(workspaceId, root)
    - Math.max(0, replacedBytes)
    + Math.max(0, incomingBytes);
  if (sizeAfter <= quotaMb * 1024 * 1024) return;
  const err = new Error(`${toDisplayPath(root, '')} quota would be exceeded (${constants.formatSizeLabel(quotaMb)} cap).`);
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
  ensureWorkspace,
  ensureAttachmentsDir,
  ensureSkillsDir,
  ensureWorkspaceWritable,
  sandboxUserString,
  rootQuotaMb,
  checkRootQuota,
  checkWritableQuotas,
  assertRootCapacity,
  wipeWorkspace
};
