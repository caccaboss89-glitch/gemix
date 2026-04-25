// src/utils/userPaths.js
// Centralized filesystem helpers for the per-user "personal cloud".
// All agentic tools (read_file, write_file, edit_file, code_execution, bash,
// project management) MUST go through resolveStorageId + isPathAllowed.

const fs = require('fs');
const path = require('path');
const {
  DATA_DIR,
  PLATFORM_DISCORD,
  MAX_PROJECT_NAME_LEN,
  MAX_USER_TOTAL_MB,
} = require('../config/constants');

// ── Constants ──

const FIXED_TOP_DIRS = ['history', 'permanent', 'projects', 'searched_images'];
const FIXED_PROJECT_SUBDIRS = ['figures', 'temp', 'output', 'code'];
const SKILLS_DIR = path.join(DATA_DIR, 'skills');

// ── Storage ID resolution (unified) ──

/**
 * Resolve the unique storageId used as the user's folder name under data/users/.
 * - Discord: userId (Discord account ID).
 * - WhatsApp group: groupId (keeps isolation between group chat vs private DMs).
 * - WhatsApp private: waJid.
 * Returns null if not resolvable.
 * @param {object} userCtx
 * @returns {string|null}
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

// ── Path helpers ──

function getUserRoot(userCtx) {
  const id = resolveStorageId(userCtx);
  if (!id) return null;
  return path.join(DATA_DIR, 'users', id);
}

function getHistoryDir(userCtx)         { const r = getUserRoot(userCtx); return r && path.join(r, 'history'); }
function getPermanentDir(userCtx)       { const r = getUserRoot(userCtx); return r && path.join(r, 'permanent'); }
function getProjectsRoot(userCtx)       { const r = getUserRoot(userCtx); return r && path.join(r, 'projects'); }
function getSearchedImagesDir(userCtx)  { const r = getUserRoot(userCtx); return r && path.join(r, 'searched_images'); }
function getStateFile(userCtx)          { const r = getUserRoot(userCtx); return r && path.join(r, '.state.json'); }

function getProjectRoot(userCtx, projectName) {
  const root = getProjectsRoot(userCtx);
  if (!root || !projectName) return null;
  return path.join(root, projectName);
}
function getProjectSubdir(userCtx, projectName, subdir) {
  const r = getProjectRoot(userCtx, projectName);
  return r && path.join(r, subdir);
}

// ── Skeleton & creation ──

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Create base folders for a user if missing. Idempotent.
 * Safe to call at the start of every agentic tool.
 */
function ensureUserSkeleton(userCtx) {
  const root = getUserRoot(userCtx);
  if (!root) return false;
  ensureDir(root);
  ensureDir(getHistoryDir(userCtx));
  ensureDir(getPermanentDir(userCtx));
  ensureDir(getProjectsRoot(userCtx));
  ensureDir(getSearchedImagesDir(userCtx));
  return true;
}

/**
 * Create the full project directory scaffold.
 */
function ensureProjectSkeleton(userCtx, projectName) {
  const proot = getProjectRoot(userCtx, projectName);
  if (!proot) return false;
  ensureDir(proot);
  for (const sub of FIXED_PROJECT_SUBDIRS) ensureDir(path.join(proot, sub));
  return true;
}

// ── Project name sanitization ──

/**
 * Sanitize a project name. Returns a lowercase slug [a-z0-9_-], max N chars.
 * Returns null if the resulting slug is empty.
 */
function sanitizeProjectName(name) {
  if (!name || typeof name !== 'string') return null;
  const slug = name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, MAX_PROJECT_NAME_LEN);
  return slug || null;
}

// ── Path-safety ──

/**
 * Strict containment check: is `target` a descendant of (or equal to) `base`?
 * Uses realpath when the path exists to defeat symlink escapes.
 * Both args MUST be absolute.
 */
function _isInside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  const rel = path.relative(b, t);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const rb = fs.existsSync(b) ? fs.realpathSync(b) : b;
    const rt = fs.existsSync(t) ? fs.realpathSync(t) : t;
    const rel2 = path.relative(rb, rt);
    return !rel2.startsWith('..') && !path.isAbsolute(rel2);
  } catch {
    return false;
  }
}

/**
 * Resolve a relative path (as the AI would pass it) into an absolute path
 * anchored at the user root, and classify what zone it belongs to.
 *
 * Rules:
 *  - Input must be a relative POSIX/Windows-ish path. Absolute paths, backslash
 *    escapes outside user root, or paths with NUL bytes are rejected.
 *  - Returns { ok, absPath, zone, projectName, subdir, reason }.
 *    zone: 'history' | 'permanent' | 'searched_images' |
 *          'project_sub' | 'project_root' | 'projects_root' | 'user_root' | 'skills' | 'outside'
 *
 * `skills:<name>.md` → resolves to DATA_DIR/skills/<name>.md (read-only, WA only).
 */
function classifyUserPath(userCtx, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, reason: 'Empty path.' };
  }
  if (rawPath.includes('\0')) {
    return { ok: false, reason: 'Invalid path (null byte).' };
  }

  // Skills special prefix
  if (rawPath.startsWith('skills:') || rawPath.startsWith('skills/')) {
    const rest = rawPath.startsWith('skills:') ? rawPath.slice(7) : rawPath.slice(7);
    if (!rest || rest.includes('..') || path.isAbsolute(rest)) {
      return { ok: false, reason: 'Invalid skills path.' };
    }
    const absPath = path.join(SKILLS_DIR, rest);
    if (!_isInside(SKILLS_DIR, absPath)) {
      return { ok: false, reason: 'Skills path escapes skills/ directory.' };
    }
    return { ok: true, absPath, zone: 'skills' };
  }

  const root = getUserRoot(userCtx);
  if (!root) return { ok: false, reason: 'Cannot resolve user root.' };

  // Reject absolute paths
  if (path.isAbsolute(rawPath)) {
    return { ok: false, reason: 'Absolute paths are not allowed.' };
  }

  const absPath = path.resolve(root, rawPath);
  if (!_isInside(root, absPath)) {
    return { ok: false, reason: 'Path escapes user folder.', zone: 'outside' };
  }

  const rel = path.relative(root, absPath).split(path.sep);
  const head = rel[0] || '';

  if (absPath === path.resolve(root)) {
    return { ok: true, absPath, zone: 'user_root' };
  }
  if (head === 'history')        return { ok: true, absPath, zone: 'history' };
  if (head === 'permanent')      return { ok: true, absPath, zone: 'permanent' };
  if (head === 'searched_images') return { ok: true, absPath, zone: 'searched_images' };
  if (head === 'projects') {
    if (rel.length === 1) return { ok: true, absPath, zone: 'projects_root' };
    const projectName = rel[1];
    if (rel.length === 2) return { ok: true, absPath, zone: 'project_root', projectName };
    const subdir = rel[2];
    return { ok: true, absPath, zone: 'project_sub', projectName, subdir };
  }
  // Anything else directly under user root (shouldn't happen except .state.json)
  return { ok: true, absPath, zone: 'user_root' };
}

/**
 * Central authorization for a path access.
 *
 * @param {object} userCtx
 * @param {string} rawPath     - relative path as provided by AI (or "skills:name.md")
 * @param {object} opts
 * @param {'read'|'write'|'delete'} opts.op
 * @param {string} [opts.currentProject]  - required for write ops
 * @param {boolean} [opts.allowHistoryWrite=false]  - never true in production
 * @returns {{ok: boolean, absPath?: string, zone?: string, projectName?: string, subdir?: string, reason?: string}}
 */
function isPathAllowed(userCtx, rawPath, opts = {}) {
  const op = opts.op || 'read';
  const c = classifyUserPath(userCtx, rawPath);
  if (!c.ok) return c;

  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  // ── Read rules ──
  if (op === 'read') {
    if (c.zone === 'skills') {
      if (isDiscord) return { ok: false, reason: 'Skills are not available on Discord.' };
      return c;
    }
    if (isDiscord && c.zone !== 'history') {
      return { ok: false, reason: 'On Discord you can only read files under history/.' };
    }
    return c;
  }

  // ── Write rules (write/delete) ──
  if (isDiscord) {
    return { ok: false, reason: 'Write operations are not available on Discord.' };
  }
  // History is strictly read-only from the AI side.
  if (c.zone === 'history' && !opts.allowHistoryWrite) {
    return { ok: false, reason: 'history/ is read-only. Copy files to permanent/ or a project instead.' };
  }
  if (c.zone === 'skills') {
    return { ok: false, reason: 'skills/ is read-only.' };
  }
  if (c.zone === 'outside') {
    return { ok: false, reason: 'Path escapes user folder.' };
  }
  if (c.zone === 'user_root' || c.zone === 'projects_root') {
    return { ok: false, reason: 'Cannot write directly in the user root or projects root. Select a project and write inside figures/, temp/, output/ or code/.' };
  }
  if (c.zone === 'project_root') {
    return { ok: false, reason: 'Cannot write directly in the project root. Use figures/, temp/, output/ or code/.' };
  }
  // permanent/ is managed via copy tools, not direct writes.
  if (c.zone === 'permanent') {
    return { ok: false, reason: 'permanent/ can only be populated via the copy_to_permanent tool.' };
  }
  // searched_images/ is populated only by the image_search tool with save_to_disk.
  if (c.zone === 'searched_images') {
    return { ok: false, reason: 'searched_images/ is managed by image_search only.' };
  }
  if (c.zone === 'project_sub') {
    if (!FIXED_PROJECT_SUBDIRS.includes(c.subdir)) {
      return { ok: false, reason: `Unknown project subdir "${c.subdir}". Allowed: ${FIXED_PROJECT_SUBDIRS.join(', ')}.` };
    }
    if (!opts.currentProject) {
      return { ok: false, reason: 'No project is currently selected. Use create_project or switch_project first.' };
    }
    if (c.projectName !== opts.currentProject) {
      return { ok: false, reason: `You can only write inside the currently selected project ("${opts.currentProject}"), not "${c.projectName}".` };
    }
    return c;
  }
  return { ok: false, reason: 'Unrecognized path zone.' };
}

// ── Project discovery ──

function listProjects(userCtx) {
  const root = getProjectsRoot(userCtx);
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const metaFile = path.join(p, '.project.json');
    let meta = {};
    try {
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    } catch { /* ignore corrupted meta */ }
    out.push({
      name,
      description: meta.description || '',
      created_at: meta.created_at || null,
      last_used_at: meta.last_used_at || null,
    });
  }
  out.sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''));
  return out;
}

function readProjectMeta(userCtx, projectName) {
  const metaFile = path.join(getProjectRoot(userCtx, projectName), '.project.json');
  if (!fs.existsSync(metaFile)) return null;
  try { return JSON.parse(fs.readFileSync(metaFile, 'utf-8')); }
  catch { return null; }
}

function writeProjectMeta(userCtx, projectName, meta) {
  const metaFile = path.join(getProjectRoot(userCtx, projectName), '.project.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
}

function projectExists(userCtx, projectName) {
  const p = getProjectRoot(userCtx, projectName);
  if (!p || !fs.existsSync(p)) return false;
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

// ── Project size accounting ──

/**
 * Recursive size in bytes of a directory. Skips unreadable entries.
 */
function dirSizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isSymbolicLink()) continue; // don't follow symlinks
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* skip */ }
    }
  }
  return total;
}

function projectSizeBytes(userCtx, projectName) {
  return dirSizeBytes(getProjectRoot(userCtx, projectName));
}

/**
 * Aggregate size of everything the AI controls under the user root:
 * projects/ (all of them) + searched_images/. history/ and permanent/ are
 * user-driven and excluded from the agentic quota on purpose.
 */
function userTotalBytes(userCtx) {
  const root = getUserRoot(userCtx);
  if (!root || !fs.existsSync(root)) return 0;
  return dirSizeBytes(path.join(root, 'projects'))
       + dirSizeBytes(path.join(root, 'searched_images'));
}

function userQuotaBytes() {
  return MAX_USER_TOTAL_MB * 1024 * 1024;
}

function isUserOverQuota(userCtx) {
  return userTotalBytes(userCtx) >= userQuotaBytes();
}

module.exports = {
  // ids & roots
  resolveStorageId,
  getUserRoot,
  getHistoryDir,
  getPermanentDir,
  getProjectsRoot,
  getSearchedImagesDir,
  getStateFile,
  getProjectRoot,
  getProjectSubdir,
  // skeleton
  ensureUserSkeleton,
  ensureProjectSkeleton,
  // names
  sanitizeProjectName,
  // safety
  classifyUserPath,
  isPathAllowed,
  // projects
  listProjects,
  readProjectMeta,
  writeProjectMeta,
  projectExists,
  projectSizeBytes,
  userTotalBytes,
  userQuotaBytes,
  isUserOverQuota,
  dirSizeBytes,
  // constants
  FIXED_TOP_DIRS,
  FIXED_PROJECT_SUBDIRS,
  SKILLS_DIR,
};
