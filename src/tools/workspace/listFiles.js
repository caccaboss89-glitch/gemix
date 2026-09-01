// src/tools/workspace/listFiles.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `list_files`: what is in `workspace/`, `attachments/`, or `skills/` where the
// chat has it, right now.
//
import constants from '../../config/constants.js';
import { listAgentDirectory, statAgentFile } from '../../sandbox/hostFileGateway.js';
import {
  ROOT,
  invalidPathError,
  parseAgentPath,
  toDisplayPath
} from '../../sandbox/workspacePaths.js';

/** Cap on entries returned in one call, so a big tree cannot flood the round. */
const MAX_ENTRIES = 300;

/**
 * @param {object} args
 * @param {string} [args.path] - directory to list, defaults to `workspace/`
 * @param {boolean} [args.recursive]
 * @param {string} workspaceId
 */
function listFiles(args = {}, workspaceId, opts = {}) {
  const raw = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : `${ROOT.WORKSPACE}/`;
  const resolved = parseAgentPath(raw, opts);
  if (!resolved) return invalidPathError(raw, opts);

  const listing = listAgentDirectory(workspaceId, resolved.display, {
    limit: MAX_ENTRIES,
    depth: args.recursive ? Infinity : 1
  });
  if (!listing) {
    if (statAgentFile(workspaceId, resolved.display)) {
      return {
        success: false,
        error: `${resolved.display} is a file, not a directory. Use read_file to read it.`
      };
    }
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
      total: 0,
      entries: [],
      directories: [],
      message: `${resolved.display} is empty.`
    };
  }

  const prefix = resolved.relPath ? `${resolved.relPath}/` : '';
  const entries = listing.files.map(f => ({
    path: toDisplayPath(resolved.root, `${prefix}${f.relPath}`),
    bytes: f.size,
    modified: new Date(f.mtimeMs).toISOString()
  }));
  const directories = listing.dirs.map(d => toDisplayPath(resolved.root, `${prefix}${d}`));

  const notes = [];
  if (listing.more) notes.push(`Only the first ${MAX_ENTRIES} of ${listing.total} files are listed.`);
  if (!args.recursive && directories.length > 0) {
    notes.push('Sub-directories are shown but not expanded; pass recursive=true to see inside them.');
  }
  if (resolved.root === ROOT.ATTACHMENTS) {
    notes.push('attachments/ is read-only. Copy a file into workspace/ before changing it.');
  } else if (resolved.root === ROOT.SKILLS) {
    notes.push(`skills/ is the shared skill library: writable, never wiped, up to ${constants.SKILLS_QUOTA_MB} MB.`);
  } else {
    notes.push(`workspace/ holds up to ${constants.WORKSPACE_QUOTA_MB} MB and is wiped after `
      + `${constants.WORKSPACE_TTL_LABEL} without activity in this chat.`);
  }

  return {
    success: true,
    status: listing.more ? 'degraded' : 'ok',
    path: resolved.display,
    total: listing.total,
    truncated: Boolean(listing.more),
    entries,
    directories,
    message: notes.join(' ')
  };
}

export { listFiles };
