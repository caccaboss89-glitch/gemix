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
import constants from '../../config/constants.js';
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
  const body = escaped.replace(/\*\*/g, globstar).replace(/\*/g, '[^/]*').replaceAll(globstar, '.*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * @param {object} args
 * @param {string} [args.namePattern] - glob on the path, e.g. "*.py" or "src/**\/*.md"
 * @param {string} [args.contains] - literal text to find inside files
 * @param {string} [args.path] - root to search, defaults to `workspace/`
 * @param {string} workspaceId
 */
function searchFiles(args = {}, workspaceId, opts = {}) {
  const namePattern = typeof args.namePattern === 'string' ? args.namePattern.trim() : '';
  const contains = typeof args.contains === 'string' ? args.contains : '';
  if (!namePattern && !contains) {
    return { success: false, error: 'Give at least one of "namePattern" or "contains".' };
  }

  const raw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : `${ROOT.WORKSPACE}/`;
  const resolved = parseAgentPath(raw, opts);
  if (!resolved) return invalidPathError(raw, opts);
  const listing = listAgentDirectory(workspaceId, resolved.display, {
    limit: constants.WORKSPACE_MAX_ENTRIES,
    maxEntries: constants.WORKSPACE_MAX_ENTRIES
  });
  if (!listing) {
    if (resolved.relPath) {
      return {
        success: false,
        error: `${resolved.display} does not exist. Use list_files on its parent directory to see what is there.`
      };
    }
    return {
      success: true,
      status: 'ok',
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
      status: candidates.length > MAX_MATCHES || !listing.complete ? 'degraded' : 'ok',
      path: resolved.display,
      matches,
      returned_matches: matches.length,
      truncated: candidates.length > MAX_MATCHES || !listing.complete,
      inventory_complete: listing.complete,
      message: candidates.length > MAX_MATCHES
        ? `${candidates.length} files match; the first ${MAX_MATCHES} are listed.`
        : `${candidates.length} file(s) match out of ${total}${listing.complete ? '.' : ' inventoried before the bounded scan stopped.'}`
    };
  }

  const matches = [];
  let scanned = 0;
  let openedFiles = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  for (const f of candidates) {
    if (matches.length >= MAX_MATCHES || openedFiles >= MAX_SCANNED_FILES) break;
    if (f.size > TEXT_SCAN_MAX_BYTES) { skippedLarge++; continue; }
    const display = toDisplayPath(resolved.root, `${prefix}${f.relPath}`);
    openedFiles++;
    let opened;
    try {
      opened = readAgentFileBuffer(workspaceId, display, TEXT_SCAN_MAX_BYTES);
    } catch {
      skippedUnreadable++;
      continue;
    }
    if (!opened) { skippedUnreadable++; continue; }
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

  const truncationReasons = [];
  if (matches.length >= MAX_MATCHES) truncationReasons.push('match_limit');
  if (openedFiles >= MAX_SCANNED_FILES && openedFiles + skippedLarge < candidates.length) truncationReasons.push('scan_limit');
  if (skippedLarge > 0) truncationReasons.push('large_files_skipped');
  if (skippedBinary > 0) truncationReasons.push('binary_files_skipped');
  if (skippedUnreadable > 0) truncationReasons.push('unreadable_files_skipped');
  if (!listing.complete) truncationReasons.push('inventory_incomplete');
  const notes = [`Searched ${scanned} text file(s) under ${resolved.display}.`];
  if (skippedBinary > 0) notes.push(`${skippedBinary} binary file(s) skipped — use read_file on those.`);
  if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) skipped as too large to scan.`);
  if (skippedUnreadable > 0) notes.push(`${skippedUnreadable} file(s) could not be read.`);
  if (truncationReasons.includes('scan_limit')) notes.push(`Stopped after opening ${MAX_SCANNED_FILES} files; narrow the query.`);
  if (matches.length >= MAX_MATCHES) notes.push(`Stopped at ${MAX_MATCHES} matches; narrow the query.`);

  return {
    success: true,
    status: truncationReasons.length > 0 ? 'degraded' : 'ok',
    path: resolved.display,
    matches,
    candidate_files: candidates.length,
    opened_files: openedFiles,
    scanned_text_files: scanned,
    skipped_binary_files: skippedBinary,
    skipped_large_files: skippedLarge,
    skipped_unreadable_files: skippedUnreadable,
    returned_matches: matches.length,
    inventory_complete: listing.complete,
    truncated: truncationReasons.includes('match_limit')
      || truncationReasons.includes('scan_limit')
      || truncationReasons.includes('inventory_incomplete'),
    truncation_reasons: truncationReasons,
    message: notes.join(' ')
  };
}

export { searchFiles };
