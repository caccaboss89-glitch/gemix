// src/sandbox/workspacePaths.js
//
// The single path namespace every tool and the structured reply share.
//
// The model sees exactly two roots and nothing else:
//
//   workspace/     its own writable area          -> /workspace in the container
//   attachments/   this conversation's files      -> /attachments, read-only
//
// One path shape means a file named by `write_file` is the same string the
// model passes to `read_file`, to `send_email`, and to `attachments[]` in the
// final reply. Nothing here resolves a bare basename against a directory
// listing: a path either names a real file or it does not (spec §18.16).
//
// A path with no root prefix is read as `workspace/`, because that is the only
// place the model can create anything. Everything else — `..`, null bytes,
// absolute host paths, a symlink pointing out of the tree — is refused.

import fs from 'fs';
import path from 'path';
import { getAttachmentsPath, getWorkspacePath } from '../utils/workspaceId.js';

/** The two roots of the namespace. Their names are also the container mounts. */
const ROOT = Object.freeze({
  WORKSPACE: 'workspace',
  ATTACHMENTS: 'attachments'
});

const HOST_ROOT_RESOLVER = Object.freeze({
  [ROOT.WORKSPACE]: getWorkspacePath,
  [ROOT.ATTACHMENTS]: getAttachmentsPath
});

/** Only `workspace/` accepts writes; `/attachments` is mounted read-only. */
function isWritableRoot(root) {
  return root === ROOT.WORKSPACE;
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
function parseAgentPath(raw) {
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
  const named = first === ROOT.WORKSPACE || first === ROOT.ATTACHMENTS;
  // `/etc/passwd` is an attempt at a host path, not a relative workspace file:
  // a leading slash only means something when it names one of the two roots.
  if (wasAbsolute && !named) return null;

  const root = first === ROOT.ATTACHMENTS ? ROOT.ATTACHMENTS : ROOT.WORKSPACE;
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
 * Containment is checked twice: once on the lexical path, and again on the
 * real path when the entry exists, so a symlink planted from inside the
 * container cannot hand back a host file.
 *
 * @returns {string|null}
 */
function hostPathFor(workspaceId, root, relPath) {
  const base = hostRoot(workspaceId, root);
  if (!base) return null;
  const abs = path.resolve(base, relPath || '');
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  let real;
  try { real = fs.realpathSync(abs); }
  catch { return abs; } // does not exist yet: the lexical check is all there is
  let realBase;
  try { realBase = fs.realpathSync(base); }
  catch { return abs; }
  const realRel = path.relative(realBase, real);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  return abs;
}

/**
 * Resolve one model-supplied path all the way to the host filesystem.
 *
 * @param {string} workspaceId
 * @param {string} raw - path as the model wrote it
 * @returns {{ root, relPath, display, containerPath, abs, writable }|null}
 */
function resolveAgentPath(workspaceId, raw) {
  const parsed = parseAgentPath(raw);
  if (!parsed) return null;
  const abs = hostPathFor(workspaceId, parsed.root, parsed.relPath);
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
function invalidPathError(raw) {
  return {
    success: false,
    error: `Invalid path ${JSON.stringify(String(raw ?? ''))}. Use "workspace/<file>" for your own files `
      + 'or "attachments/<file>" for this conversation\'s files. Parent traversal and host paths are refused.'
  };
}

export {
  ROOT,
  parseAgentPath,
  resolveAgentPath,
  hostRoot,
  hostPathFor,
  toDisplayPath,
  toContainerPath,
  isWritableRoot,
  invalidPathError
};
