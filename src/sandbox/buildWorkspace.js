// src/sandbox/buildWorkspace.js
//
// Filesystem-side helpers for the build sub-agent's workspace.
//
// Layout (per §2.3 of Analisi_Pulizia_v2.md):
//   data/users/<workspaceSlug>/
//     build_workspace/        <- writable root, no fixed structure
//     .build_state.json       <- activity + lock (utils/buildState.js)
//
// The agent treats `/workspace` (its container's bind-mount of the
// workspace path) as a single flat zone with no required layout. Files
// dropped here as attachments via the `build` tool, plus anything the
// agent writes itself, all live in the same tree.
//
// Quota: BUILD_WORKSPACE_QUOTA_MB. The agent's write tools (write_file,
// edit_file, bash) check this before each write; the host enforces it
// when copying attachments in.

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

function _safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
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
 * Listing of workspace files for the <WorkspaceState> block injected in the
 * sub-agent's system prompt and the <UserWorkspace> block on the main brain.
 * Returns: [{ relPath, size, mtimeMs }].
 *
 * `limit` caps the output size: if the workspace has more than `limit`
 * files, we return the first `limit` entries plus a sentinel `_more` count
 * (caller renders "... and N more").
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
function workspaceIsEmpty(workspaceId) {
  const root = getBuildWorkspacePath(workspaceId);
  if (!root || !fs.existsSync(root)) return true;
  try {
    return fs.readdirSync(root).length === 0;
  } catch { return true; }
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
  workspaceSizeBytes,
  listWorkspaceFiles,
  stageAttachmentBuffer,
  stageAttachmentFromPath,
  wipeWorkspace,
  workspaceIsEmpty,
  resolveInsideWorkspace,
  QUOTA_BYTES,
};
