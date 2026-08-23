// src/tools/workspace/editFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `edit_file`: replace an exact string in a file that is already there.
//
// The contract is unique search & replace. A `oldText` that matches more than
// once is refused rather than guessed at, because the model cannot see which
// occurrence it hit and a silent wrong edit is worse than an error it can fix
// by quoting more surrounding lines. `replaceAll` is the explicit opt-out.
//
// The read is host-side (fast, our own code); the write goes back through the
// container, same as write_file, so both mutations follow one path.

import fs from 'fs';
import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWorkspaceQuota } from '../../sandbox/workspaceFs.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { isProbablyText } from './textFiles.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

const WRITE_SCRIPT = 'cat > "$1"';

function _countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.oldText
 * @param {string} args.newText
 * @param {boolean} [args.replaceAll]
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.lockOwnerId]
 */
async function editFile(args = {}, workspaceId, opts = {}) {
  const raw = typeof args.path === 'string' ? args.path : '';
  if (!raw.trim()) return { success: false, error: 'Missing required argument "path".' };
  if (typeof args.oldText !== 'string' || args.oldText === '') {
    return { success: false, error: 'Missing required argument "oldText" (the exact text to replace).' };
  }
  if (typeof args.newText !== 'string') {
    return { success: false, error: 'Missing required argument "newText" (pass an empty string to delete the text).' };
  }

  const resolved = resolveAgentPath(workspaceId, raw);
  if (!resolved) return invalidPathError(raw);
  if (!resolved.writable) {
    return {
      success: false,
      error: `${resolved.display} is read-only. Copy it into workspace/ first, then edit there.`
    };
  }

  return withWorkspaceLock(workspaceId, { ownerId: opts.lockOwnerId }, async () => {
    let buffer;
    try {
      const stat = fs.statSync(resolved.abs);
      if (!stat.isFile()) return { success: false, error: `${resolved.display} is not a file.` };
      buffer = fs.readFileSync(resolved.abs);
    } catch {
      return {
        success: false,
        error: `${resolved.display} does not exist. Use write_file to create it.`
      };
    }
    if (!isProbablyText(buffer)) {
      return { success: false, error: `${resolved.display} is binary; edit_file only works on text.` };
    }

    const before = buffer.toString('utf-8');
    const occurrences = _countOccurrences(before, args.oldText);
    if (occurrences === 0) {
      return {
        success: false,
        error: `That exact text is not in ${resolved.display}. Read the file again and copy the target text verbatim, whitespace included.`
      };
    }
    if (occurrences > 1 && !args.replaceAll) {
      return {
        success: false,
        error: `"oldText" matches ${occurrences} times in ${resolved.display}. `
          + 'Include enough surrounding lines to make it unique, or pass replaceAll=true to change every occurrence.'
      };
    }

    const after = args.replaceAll
      ? before.split(args.oldText).join(args.newText)
      : before.replace(args.oldText, args.newText);

    const run = await workspaceRuntime.execInWorkspace(workspaceId, {
      command: ['/bin/bash', '-c', WRITE_SCRIPT, 'edit_file', resolved.containerPath],
      input: after
    });
    if (run.rc !== 0) {
      return {
        success: false,
        error: `Could not write ${resolved.display}: ${(run.stderr || run.stdout || `exit ${run.rc}`).trim().slice(0, 400)}`
      };
    }

    const quota = checkWorkspaceQuota(workspaceId);
    const replaced = args.replaceAll ? occurrences : 1;
    return {
      success: true,
      path: resolved.display,
      replacements: replaced,
      bytes: Buffer.byteLength(after, 'utf-8'),
      message: quota.ok
        ? `Replaced ${replaced} occurrence(s) in ${resolved.display}.`
        : `Replaced ${replaced} occurrence(s) in ${resolved.display}. ${quota.message}`,
      ...(quota.ok ? {} : { quota_exceeded: true, quota_mb: constants.WORKSPACE_QUOTA_MB })
    };
  }).catch((err) => {
    if (err.code === 'EWORKSPACEBUSY') return { success: false, error: err.message };
    throw err;
  });
}

export { editFile };
