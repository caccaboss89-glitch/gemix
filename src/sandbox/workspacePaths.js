// src/sandbox/workspacePaths.js
//
// The single path namespace every tool and the structured reply share.
//
// The model sees these roots and nothing else:
//
//   workspace/     its own writable area          -> /workspace in the container
//   attachments/   this conversation's files      -> /attachments, read-only
//   skills/        the shared skill library       -> /skills, read-only
//
// `workspace/` is the one root the model writes in. The library ships with the
// repo: the model reads a skill and runs its scripts, it does not maintain it.
//
// The third one is a platform capability (see config/platformCapabilities.js).
// Where the chat does not have it, callers pass `skills: false` and `skills` is
// not a root name here at all: such a path is an ordinary workspace directory.
//
// One path shape means a file named by `write_file` is the same string the
// model passes to `read_file`, to `send_email`, and to `attachments[]` in the
// final reply. Nothing here resolves a bare basename against a directory
// listing: a path either names a real file or it does not.
//
// `workspace/` and `attachments/` belong to one conversation; `skills/` is the
// same directory for every chat on the deployment, which is why its resolver
// ignores the workspace id.
//
// A path with no root prefix is read as `workspace/`, because that is where the
// model creates things unless it says otherwise. Everything else — `..`, null
// bytes, absolute host paths, a symlink pointing out of the tree — is refused.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getAttachmentsPath, getWorkspacePath } from '../utils/workspaceId.js';

/** The three roots of the namespace. Their names are also the container mounts. */
const ROOT = Object.freeze({
  WORKSPACE: 'workspace',
  ATTACHMENTS: 'attachments',
  SKILLS: 'skills'
});

const HOST_ROOT_RESOLVER = Object.freeze({
  [ROOT.WORKSPACE]: getWorkspacePath,
  [ROOT.ATTACHMENTS]: getAttachmentsPath,
  [ROOT.SKILLS]: () => constants.SKILLS_DIR
});

/** Every root the model may create, change and delete files in. */
const WRITABLE_ROOTS = Object.freeze([ROOT.WORKSPACE]);

/** Lowercased root names, for deciding whether a first segment names a root. */
const ROOT_NAMES = new Set(Object.values(ROOT));

/** `workspace/` is the one root that accepts writes; the other two are mounted read-only. */
function isWritableRoot(root) {
  return WRITABLE_ROOTS.includes(root);
}

/**
 * Split a model-supplied path into `{ root, relPath }`.
 *
 * Accepts `workspace/a/b.txt`, `/workspace/a/b.txt`, `./a/b.txt`, backslashes
 * and a `file://` prefix. Returns null when the path escapes the namespace or
 * carries nothing usable.
 *
 * @param {string} raw
 * @returns {{ root: string, relPath: string, display: string }|null}
 */
function parseAgentPath(raw, { skills = true } = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.includes('\0')) return null;

  s = s.replace(/\\/g, '/');
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(s.replace(/^file:\/\//i, '/')); }
    catch { s = s.replace(/^file:\/\//i, '/'); }
  }
  // A Windows-style drive letter is a host path, never a namespace path.
  if (/^[a-z]:\//i.test(s)) return null;

  while (s.startsWith('./')) s = s.slice(2);
  const wasAbsolute = s.startsWith('/');
  s = s.replace(/^\/+/, '');
  if (!s) return null;

  const segments = s.split('/').filter(seg => seg !== '' && seg !== '.');
  if (segments.length === 0) return null;
  if (segments.some(seg => seg === '..')) return null;

  const first = segments[0].toLowerCase();
  // Where the skill library is not offered, `skills` is not a root name: a path
  // starting with it is an ordinary workspace directory, exactly like any other
  // first segment the namespace does not recognise.
  const named = ROOT_NAMES.has(first) && (skills || first !== ROOT.SKILLS);
  // `/etc/passwd` is an attempt at a host path, not a relative workspace file:
  // a leading slash only means something when it names one of the roots.
  if (wasAbsolute && !named) return null;

  const root = named ? first : ROOT.WORKSPACE;
  // A rootless path belongs to the workspace, so only strip a prefix we matched.
  const rest = named ? segments.slice(1) : segments;
  const relPath = rest.join('/');
  return { root, relPath, display: toDisplayPath(root, relPath) };
}

/** The canonical string the model sees: `workspace/sub/file.txt`. */
function toDisplayPath(root, relPath) {
  return relPath ? `${root}/${relPath}` : `${root}/`;
}

/** The path the same file has inside the container: `/workspace/sub/file.txt`. */
function toContainerPath(root, relPath) {
  return relPath ? `/${root}/${relPath}` : `/${root}`;
}

/** Host directory backing one root, or null when the workspace cannot resolve. */
function hostRoot(workspaceId, root) {
  const resolve = HOST_ROOT_RESOLVER[root];
  return resolve ? resolve(workspaceId) : null;
}

/**
 * Host path for a `{root, relPath}` pair, refusing anything outside the root.
 *
 * Containment is checked twice: once on the lexical path, and again after
 * resolving the nearest existing ancestor. The latter also protects a missing
 * destination whose parent is a symlink. Mutations additionally reject every
 * existing symlink component to keep path identity stable until commit.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forWrite]
 * @returns {string|null}
 */
function hostPathFor(workspaceId, root, relPath, opts = {}) {
  const base = hostRoot(workspaceId, root);
  if (!base) return null;
  const abs = path.resolve(base, relPath || '');
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  if (opts.forWrite && _hasExistingSymlink(base, rel)) return null;

  const realBase = _prospectiveRealPath(base);
  const real = _prospectiveRealPath(abs);
  if (!realBase || !real) return null;
  const realRel = path.relative(realBase, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  return abs;
}

/** Canonicalize an existing path, or its nearest existing ancestor plus tail. */
function _prospectiveRealPath(target) {
  let existing = target;
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
  }
  try {
    const realExisting = fs.realpathSync(existing);
    return path.resolve(realExisting, path.relative(existing, target));
  } catch {
    return null;
  }
}

/** Whether an existing component below `base` is a symbolic link. */
function _hasExistingSymlink(base, relPath) {
  let current = base;
  try {
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return true;
  }
  for (const segment of relPath.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
      return true;
    }
  }
  return false;
}

/**
 * Resolve one model-supplied path all the way to the host filesystem.
 *
 * @param {string} workspaceId
 * @param {string} raw - path as the model wrote it
 * @param {object} [opts]
 * @param {boolean} [opts.forWrite] - reject existing symlink components
 * @returns {{ root, relPath, display, containerPath, abs, writable }|null}
 */
function resolveAgentPath(workspaceId, raw, opts = {}) {
  const parsed = parseAgentPath(raw, opts);
  if (!parsed) return null;
  const abs = hostPathFor(workspaceId, parsed.root, parsed.relPath, opts);
  if (!abs) return null;
  return {
    ...parsed,
    abs,
    containerPath: toContainerPath(parsed.root, parsed.relPath),
    writable: isWritableRoot(parsed.root)
  };
}

/**
 * The structured refusal every tool returns for a path it will not touch.
 * @param {string} raw
 * @returns {{ success: false, error: string }}
 */
function invalidPathError(raw, { skills = true } = {}) {
  const roots = '"workspace/<file>" for your own files, "attachments/<file>" for this conversation\'s files'
    + (skills ? ', or "skills/<name>/<file>" for the skill library' : '');
  return {
    success: false,
    error: `Invalid path ${JSON.stringify(String(raw ?? ''))}. Use ${roots}. `
      + 'Parent traversal and host paths are refused.'
  };
}

export {
  ROOT,
  WRITABLE_ROOTS,
  parseAgentPath,
  resolveAgentPath,
  hostRoot,
  toDisplayPath,
  toContainerPath,
  isWritableRoot,
  invalidPathError
};
