// src/sandbox/workspaceFs.js
//
// Host-side filesystem for the agent's two roots.
//
// Per-conversation layout under data/users/<workspaceSlug>/ :
//   build_workspace/        <- /workspace, writable by the agent
//   attachments/            <- /attachments, read-only projection
//   .build_state.json       <- activity timestamp (see utils/workspaceState.js)
//   .workspace_lock/        <- atomic mutation mutex (same module)
//
// Reads run here, in-process, because they only ever execute GemiX's own code
// and a docker exec per listing would cost more than the read itself. Writes
// and shell go through the container (see workspaceRuntime.js); this module is
// what checks afterwards that the workspace still fits its quota.
//
// Quota: constants.WORKSPACE_QUOTA_MB over the workspace tree. The attachment
// projection is not the agent's to fill, so it does not count against it.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getAttachmentsPath, getWorkspacePath } from '../utils/workspaceId.js';
import { sanitizeFilename } from '../utils/text.js';
import { createLogger } from '../utils/logger.js';

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

/**
 * Recursive size in bytes of a directory tree. Symlinks are NOT followed
 * to avoid escapes via crafted links from inside the container.
 */
function _treeSizeBytes(root) {
  if (!root || !fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
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

/** Recursive size in bytes of the workspace tree. */
function workspaceSizeBytes(workspaceId) {
  return _treeSizeBytes(getWorkspacePath(workspaceId));
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
 * Check the quota after a mutation and report the overrun.
 *
 * Enforcement is deliberately after the fact and best-effort: the write itself
 * happens inside the container, where a pre-flight host check would be a guess
 * and a hard block would leave the agent unable to clean up. The agent is told
 * it is over and must delete something.
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

/**
 * Listing of the files under one root. Returns [{ relPath, size, mtimeMs }].
 *
 * `limit` caps the output size: with more than `limit` files the first `limit`
 * entries come back plus a `more` flag (caller renders "... and more").
 * `depth` of 1 lists only the root's own entries, which is what the Runtime
 * block shows.
 *
 * @param {string} root - absolute host directory
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.depth] - Infinity by default
 * @param {string} [opts.subPath] - list this directory inside the root
 */
function listFilesUnder(root, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
  const maxDepth = Number.isFinite(opts.depth) ? opts.depth : Infinity;
  const start = opts.subPath ? path.join(root, opts.subPath) : root;
  if (!root || !fs.existsSync(start)) return { files: [], dirs: [], total: 0, more: false };

  const files = [];
  const dirs = [];
  let total = 0;
  const stack = [{ dir: start, depth: 1 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (e.isDirectory()) {
          if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
          else dirs.push(rel);
          continue;
        }
        if (!e.isFile()) continue;
        total++;
        if (files.length < limit) {
          const st = fs.statSync(full);
          files.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
        }
      } catch { /* skip */ }
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  dirs.sort();
  return { files, dirs, total, more: total > limit };
}

/** Listing of the workspace tree. Same shape as listFilesUnder. */
function listWorkspaceFiles(workspaceId, limit = 200, opts = {}) {
  const root = getWorkspacePath(workspaceId);
  if (!root) return { files: [], dirs: [], total: 0, more: false };
  return listFilesUnder(root, { ...opts, limit });
}

function _collisionFreeName(root, desiredName, fallback) {
  const baseName = sanitizeFilename(path.basename(desiredName || fallback));
  if (!baseName) throw new Error('Empty attachment name after sanitization');
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let finalName = baseName;
  let i = 1;
  while (fs.existsSync(path.join(root, finalName))) {
    finalName = `${stem}(${i})${ext}`;
    i++;
    if (i > 999) throw new Error('Too many attachment-name collisions in workspace');
  }
  return { baseName, finalName };
}

function _refuseOverQuota(workspaceId, incomingBytes) {
  const sizeBefore = workspaceSizeBytes(workspaceId);
  if (sizeBefore + incomingBytes <= QUOTA_BYTES) return;
  const err = new Error(`Workspace quota would be exceeded (${constants.WORKSPACE_QUOTA_MB} MB cap).`);
  err.code = 'EQUOTA';
  throw err;
}

/**
 * Copy a buffer into the workspace root, renaming on collision so the caller
 * always gets a unique path. Returns the final filename used.
 *
 * `desiredName` is sanitized (basename + sanitizeFilename) to keep the name
 * filesystem-safe and to forbid any traversal. Refuses the write when the
 * resulting workspace size would exceed the quota, throwing with
 * `code='EQUOTA'` so the caller can surface a clear message.
 */
function stageAttachmentBuffer(workspaceId, desiredName, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('stageAttachmentBuffer: buffer must be a Buffer');
  }
  const root = ensureWorkspace(workspaceId);
  if (!root) throw new Error('Cannot resolve workspace path');

  const { baseName, finalName } = _collisionFreeName(root, desiredName, 'attachment');
  _refuseOverQuota(workspaceId, buffer.length);

  fs.writeFileSync(path.join(root, finalName), buffer);
  return { finalName, renamed: finalName !== baseName, originalName: baseName, sizeBytes: buffer.length };
}

/**
 * Copy a host file into the workspace root using the same rename-on-collision
 * + quota policy as stageAttachmentBuffer. Used when the file is already
 * persisted on disk and the bytes need not round-trip through a Buffer.
 */
function stageAttachmentFromPath(workspaceId, desiredName, srcPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source file does not exist: ${srcPath}`);
  }
  const stat = fs.statSync(srcPath);
  if (!stat.isFile()) throw new Error(`Source is not a file: ${srcPath}`);

  const root = ensureWorkspace(workspaceId);
  if (!root) throw new Error('Cannot resolve workspace path');

  const { baseName, finalName } = _collisionFreeName(root, desiredName, path.basename(srcPath));
  _refuseOverQuota(workspaceId, stat.size);

  fs.copyFileSync(srcPath, path.join(root, finalName));
  return { finalName, renamed: finalName !== baseName, originalName: baseName, sizeBytes: stat.size };
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
  listFilesUnder,
  listWorkspaceFiles,
  workspaceSizeBytes,
  workspaceQuotaState,
  checkWorkspaceQuota,
  stageAttachmentBuffer,
  stageAttachmentFromPath,
  wipeWorkspace
};
