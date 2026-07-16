// src/sandbox/buildWorkspace.js
//
// Filesystem-side helpers for the build sub-agent's workspace.
//
// Per-workspace layout under data/users/<workspaceSlug>/ :
//   build_workspace/        <- writable root (flat, no fixed structure)
//   .build_state.json       <- activity + lock (see utils/buildState.js)
//
// The agent sees `/workspace` as a single flat zone. Attachments staged
// by the `build` tool and anything the agent writes live in the same tree.
//
// Quota: BUILD_WORKSPACE_QUOTA_MB. Enforced on writes and on attachment staging.

const fs = require('fs');
const path = require('path');
const { BUILD_WORKSPACE_QUOTA_MB } = require('../config/constants');
const { getBuildWorkspacePath } = require('../utils/workspaceId');
const { sanitizeFilename } = require('../utils/text');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildWorkspace');

const QUOTA_BYTES = BUILD_WORKSPACE_QUOTA_MB * 1024 * 1024;

/**
 * Ensure the workspace directory exists for `workspaceId`. Returns the
 * absolute path, or null if the workspaceId can't be resolved.
 */
function ensureWorkspace(workspaceId) {
  const dir = getBuildWorkspacePath(workspaceId);
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { log.warn(`mkdir ${dir}: ${err.message}`); return null; }
  return dir;
}

/**
 * UID/GID the build sandbox container should use so bind-mounted files are
 * owned by the same user as the Node process (host harvest / staging).
 */
function hostSandboxIds() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  return { uid, gid };
}

/** Docker `User` string for container create / exec (fallback 1000:1000 off Linux). */
function sandboxUserString() {
  const { uid, gid } = hostSandboxIds();
  if (uid == null || gid == null) return '1000:1000';
  return `${uid}:${gid}`;
}

/**
 * Make the workspace tree writable on the host. The sandbox container runs as
 * the same UID/GID as Node; this fixes legacy files from older containers and
 * normalizes permissions on directories.
 */
function ensureWorkspaceWritable(workspaceId) {
  const root = getBuildWorkspacePath(workspaceId);
  if (!root || !fs.existsSync(root)) return;
  if (process.platform !== 'linux') return;

  const { uid, gid } = hostSandboxIds();
  if (uid == null || gid == null) return;

  const isRoot = process.getuid && process.getuid() === 0;

  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); }
    catch { return; }

    try {
      if (isRoot) {
        if (st.uid !== uid || st.gid !== gid) fs.chownSync(p, uid, gid);
        fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
      } else if (st.uid === uid) {
        fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
      }
      // Foreign-owned entries (legacy sandbox uid): skip — container recreate fixes new files.
    } catch (err) {
      log.warn(`ensureWorkspaceWritable ${p}: ${err.message}`);
    }

    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p); }
      catch { return; }
      for (const entry of entries) walk(path.join(p, entry));
    }
  };
  walk(root);
}

/**
 * Recursive size in bytes of the workspace tree. Symlinks are NOT followed
 * to avoid escapes via crafted links from inside the container.
 */
function workspaceSizeBytes(workspaceId) {
  const root = getBuildWorkspacePath(workspaceId);
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

/**
 * Listing of workspace files for main-brain <BuildWorkspace> and build harvest.
 * Returns: [{ relPath, size, mtimeMs }].
 *
 * `limit` caps the output size: if the workspace has more than `limit`
 * files, we return the first `limit` entries plus a sentinel more flag
 * (caller renders "... and more").
 */
function listWorkspaceFiles(workspaceId, limit = 200) {
  const root = getBuildWorkspacePath(workspaceId);
  if (!root || !fs.existsSync(root)) return { files: [], total: 0 };

  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit + 1) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit + 1) break;
      const full = path.join(cur, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!e.isFile()) continue;
        const st = fs.statSync(full);
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  }

  if (out.length > limit) {
    return { files: out.slice(0, limit), total: out.length, more: true };
  }
  return { files: out, total: out.length, more: false };
}

/**
 * Copy a buffer into the workspace root, renaming on collision so the
 * agent always gets a unique path. Returns the final filename used.
 *
 * The function is the host-side mechanism used by the `build` tool to
 * stage attachments in the workspace before delegating to the agent.
 *
 * `desiredName` is sanitized (basename + sanitizeFilename) to keep the
 * name filesystem-safe and to forbid any traversal.
 *
 * Quota: refuses the write when the resulting workspace size would exceed
 * QUOTA_BYTES. Throws an Error with `code='EQUOTA'` so the caller can
 * surface a clear message.
 */
function stageAttachmentBuffer(workspaceId, desiredName, buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('stageAttachmentBuffer: buffer must be a Buffer');
  }
  const root = ensureWorkspace(workspaceId);
  if (!root) throw new Error('Cannot resolve workspace path');

  const baseName = sanitizeFilename(path.basename(desiredName || 'attachment'));
  if (!baseName) throw new Error('Empty attachment name after sanitization');

  // Find a collision-free filename.
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let finalName = baseName;
  let i = 1;
  while (fs.existsSync(path.join(root, finalName))) {
    finalName = `${stem}(${i})${ext}`;
    i++;
    if (i > 999) throw new Error('Too many attachment-name collisions in workspace');
  }

  // Quota check after compute, before write.
  const sizeBefore = workspaceSizeBytes(workspaceId);
  if (sizeBefore + buffer.length > QUOTA_BYTES) {
    const err = new Error(`Workspace quota would be exceeded (${BUILD_WORKSPACE_QUOTA_MB} MB cap).`);
    err.code = 'EQUOTA';
    throw err;
  }

  const dest = path.join(root, finalName);
  fs.writeFileSync(dest, buffer);
  return { finalName, renamed: finalName !== baseName, originalName: baseName, sizeBytes: buffer.length };
}

/**
 * Copy a host file into the workspace root using the same rename-on-collision
 * + quota policy as stageAttachmentBuffer. Used when we already have the
 * file persisted on disk (chat history) and don't want to round-trip the
 * bytes through a Buffer.
 */
function stageAttachmentFromPath(workspaceId, desiredName, srcPath) {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source file does not exist: ${srcPath}`);
  }
  const stat = fs.statSync(srcPath);
  if (!stat.isFile()) throw new Error(`Source is not a file: ${srcPath}`);

  const root = ensureWorkspace(workspaceId);
  if (!root) throw new Error('Cannot resolve workspace path');

  const baseName = sanitizeFilename(path.basename(desiredName || path.basename(srcPath)));
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

  const sizeBefore = workspaceSizeBytes(workspaceId);
  if (sizeBefore + stat.size > QUOTA_BYTES) {
    const err = new Error(`Workspace quota would be exceeded (${BUILD_WORKSPACE_QUOTA_MB} MB cap).`);
    err.code = 'EQUOTA';
    throw err;
  }

  const dest = path.join(root, finalName);
  fs.copyFileSync(srcPath, dest);
  return { finalName, renamed: finalName !== baseName, originalName: baseName, sizeBytes: stat.size };
}

/**
 * Wipe everything inside the workspace, leaving the root dir intact.
 * Used by the TTL sweeper. The `.build_state.json` lives one level up
 * (in the meta dir), so it is NOT touched here.
 */
function wipeWorkspace(workspaceId) {
  const root = getBuildWorkspacePath(workspaceId);
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

/**
 * Returns true when there is at least one file in the workspace tree.
 * Used by the main brain's system prompt builder to decide whether to
 * inject a <UserWorkspace> block.
 */
/**
 * Normalize a workspace path from a harvest entry or staged name
 * to a relative path under the workspace root.
 *
 * Accepts common variants: "song.mp3", "/workspace/song.mp3", "workspace/song.mp3",
 * "out/song.mp3", "./song.mp3", backslashes, optional file:// prefix.
 * Returns null for empty paths, null bytes, or .. escape attempts.
 */
function normalizeWorkspaceRelPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let s = rawPath.trim();
  if (!s || s.includes('\0')) return null;

  s = s.replace(/\\/g, '/');

  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, '/'));
    } catch {
      s = s.replace(/^file:\/\//i, '');
    }
  }

  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  while (/^workspace\//i.test(s)) s = s.slice(/^workspace\//i.exec(s)[0].length);
  if (!s) return null;

  const segments = s.split('/').filter(seg => seg !== '' && seg !== '.');
  if (segments.some(seg => seg === '..')) return null;
  return segments.join('/');
}

/** Loose key for matching basenames when spaces/underscores/punctuation differ. */
function looseBasenameKey(name) {
  const base = path.basename(String(name || '')).normalize('NFC');
  const ext = path.extname(base).toLowerCase();
  const stem = ext ? base.slice(0, -ext.length) : base;
  const stemKey = stem
    .toLowerCase()
    .replace(/[\s_.-]+/g, '')
    .replace(/[^a-z0-9àèéìòù]/g, '');
  const extKey = ext.replace(/[^a-z0-9]/g, '');
  return stemKey + extKey;
}

/**
 * Resolve a workspace delivery path to an on-disk file.
 * Tries exact path, then case-insensitive basename, then loose basename match
 * (spaces vs underscores) when the match is unambiguous.
 *
 * @returns {{ abs: string, relPath: string } | null}
 */
function resolveWorkspaceDeliveryFile(workspaceId, wsRel) {
  if (!wsRel || typeof wsRel !== 'string') return null;
  const normalized = wsRel.normalize('NFC');
  if (normalized.split('/').some(seg => seg === '..' || seg === '.')) return null;

  const tryRel = (relativePath) => {
    const abs = resolveInsideWorkspace(workspaceId, relativePath);
    if (!abs || !fs.existsSync(abs)) return null;
    try {
      return fs.statSync(abs).isFile() ? { abs, relPath: relativePath } : null;
    } catch {
      return null;
    }
  };

  for (const candidate of new Set([normalized, wsRel])) {
    const exact = tryRel(candidate);
    if (exact) return exact;
  }

  const { files } = listWorkspaceFiles(workspaceId, 500);
  if (files.length === 0) return null;

  const baseLower = path.basename(normalized).toLowerCase();
  const caseMatches = files.filter(
    f => path.basename(f.relPath).normalize('NFC').toLowerCase() === baseLower,
  );
  if (caseMatches.length === 1) return tryRel(caseMatches[0].relPath);

  const wantKey = looseBasenameKey(normalized);
  if (!wantKey) return null;
  const looseMatches = files.filter(f => looseBasenameKey(f.relPath) === wantKey);
  if (looseMatches.length === 1) return tryRel(looseMatches[0].relPath);

  return null;
}

/**
 * Resolve a relative path inside the workspace, ensuring containment.
 * Returns absolute path on success, null on escape attempt.
 */
function resolveInsideWorkspace(workspaceId, relPath) {
  const root = getBuildWorkspacePath(workspaceId);
  if (!root || typeof relPath !== 'string') return null;
  if (relPath.includes('\0')) return null;
  const normalized = relPath.replace(/^\/+/, '');
  const abs = path.resolve(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

module.exports = {
  ensureWorkspace,
  ensureWorkspaceWritable,
  hostSandboxIds,
  sandboxUserString,
  workspaceSizeBytes,
  listWorkspaceFiles,
  stageAttachmentBuffer,
  stageAttachmentFromPath,
  wipeWorkspace,
  resolveInsideWorkspace,
  normalizeWorkspaceRelPath,
  resolveWorkspaceDeliveryFile,
  QUOTA_BYTES,
};
