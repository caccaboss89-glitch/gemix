// src/tools/workspace/searchFiles.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `search_files`: find files by name, or lines by content, under one root.
//
// Host-side, in-process. Content search only opens files that look textual and
// are small enough to be worth scanning — a grep across a 400 MB video would
// spend the turn's time budget on noise.

import path from 'path';
import { listAgentDirectory, readAgentFileBuffer } from '../../sandbox/hostFileGateway.js';
import {
  ROOT,
  invalidPathError,
  parseAgentPath,
  toDisplayPath
} from '../../sandbox/workspacePaths.js';
import { isProbablyText, TEXT_SCAN_MAX_BYTES } from './textFiles.js';

/** Cap on reported matches, so one broad query cannot flood the round. */
const MAX_MATCHES = 100;
/** Cap on files opened for a content search in one call. */
const MAX_SCANNED_FILES = 400;
/** Longest slice of a matching line reported back. */
const MAX_LINE_CHARS = 300;

function _globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const globstar = '__GEMIX_GLOBSTAR__';
  const body = escaped.replace(/\*\*/g, globstar).replace(/\*/g, '[^/]*').replaceAll(globstar, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * @param {object} args
 * @param {string} [args.namePattern] - glob on the path, e.g. "*.py" or "src/**\/*.md"
 * @param {string} [args.contains] - literal text to find inside files
 * @param {string} [args.path] - root to search, defaults to `workspace/`
 * @param {string} workspaceId
 */
function searchFiles(args = {}, workspaceId) {
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.trim() : '';
  const contains = typeof args.contains === 'string' ? args.contains : '';
  if (!namePattern && !contains) {
    return { success: false, error: 'Give at least one of "namePattern" or "contains".' };
  }

  const raw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : `${ROOT.WORKSPACE}/`;
  const resolved = parseAgentPath(raw);
  if (!resolved) return invalidPathError(raw);
  const listing = listAgentDirectory(workspaceId, resolved.display, { limit: 10_000 });
  if (!listing) {
    if (resolved.relPath) {
      return {
        success: false,
        error: `${resolved.display} does not exist. Use list_files on its parent directory to see what is there.`
      };
    }
    return {
      success: true,
      path: resolved.display,
      matches: [],
      message: `${resolved.display} is empty.`
    };
  }
  const { files, total } = listing;
  const prefix = resolved.relPath ? `${resolved.relPath}/` : '';
  const nameRe = namePattern ? _globToRegExp(namePattern) : null;

  const candidates = files.filter((f) => {
    if (!nameRe) return true;
    // A pattern with no slash matches the basename; one with a slash matches
    // the whole relative path, which is how the model writes it.
    return namePattern.includes('/') ? nameRe.test(f.relPath) : nameRe.test(path.basename(f.relPath));
  });

  if (!contains) {
    const matches = candidates.slice(0, MAX_MATCHES).map(f => ({
      path: toDisplayPath(resolved.root, `${prefix}${f.relPath}`),
      bytes: f.size
    }));
    return {
      success: true,
      path: resolved.display,
      matches,
      message: candidates.length > MAX_MATCHES
        ? `${candidates.length} files match; the first ${MAX_MATCHES} are listed.`
        : `${candidates.length} file(s) match out of ${total}.`
    };
  }

  const matches = [];
  let scanned = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;
  for (const f of candidates) {
    if (matches.length >= MAX_MATCHES || scanned >= MAX_SCANNED_FILES) break;
    if (f.size > TEXT_SCAN_MAX_BYTES) { skippedLarge++; continue; }
    const display = toDisplayPath(resolved.root, `${prefix}${f.relPath}`);
    const opened = readAgentFileBuffer(workspaceId, display, TEXT_SCAN_MAX_BYTES);
    if (!opened) continue;
    const content = opened.buffer;
    if (!isProbablyText(content)) { skippedBinary++; continue; }
    scanned++;
    const lines = content.toString('utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      if (!lines[i].includes(contains)) continue;
      matches.push({
        path: toDisplayPath(resolved.root, `${prefix}${f.relPath}`),
        line: i + 1,
        text: lines[i].slice(0, MAX_LINE_CHARS)
      });
    }
  }

  const notes = [`Searched ${scanned} text file(s) under ${resolved.display}.`];
  if (skippedBinary > 0) notes.push(`${skippedBinary} binary file(s) skipped — use read_file on those.`);
  if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) skipped as too large to scan.`);
  if (matches.length >= MAX_MATCHES) notes.push(`Stopped at ${MAX_MATCHES} matches; narrow the query.`);

  return { success: true, path: resolved.display, matches, message: notes.join(' ') };
}

export { searchFiles };
