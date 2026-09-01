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
// The read uses the descriptor-safe host gateway; the write goes through the
// container, same as write_file, so both mutations follow one path.

import constants from '../../config/constants.js';
import { readAgentFileBuffer } from '../../sandbox/hostFileGateway.js';
import { assertRootCapacity } from '../../sandbox/workspaceFs.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { isProbablyText } from './textFiles.js';
import {
  commitWorkspaceText,
  quotaResultFields,
  runWorkspaceMutation
} from './mutation.js';

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

  const resolved = resolveAgentPath(workspaceId, raw, { ...opts, forWrite: true });
  if (!resolved) return invalidPathError(raw, opts);
  if (!resolved.writable) {
    return {
      success: false,
      error: `${resolved.display} is read-only. Copy it into workspace/ first, then edit there.`
    };
  }

  return runWorkspaceMutation(workspaceId, opts, async () => {
    // Re-resolve before the read while holding the lock. This closes the gap
    // between the initial permission check and the read-transform-write cycle.
    const lockedResolved = resolveAgentPath(workspaceId, raw, { ...opts, forWrite: true });
    if (!lockedResolved || !lockedResolved.writable) return invalidPathError(raw, opts);
    let opened;
    try {
      opened = readAgentFileBuffer(workspaceId, raw, constants.WORKSPACE_EDIT_MAX_BYTES);
    } catch (err) {
      if (err?.code === 'EFILETOOLARGE') {
        return { success: false, error: `${lockedResolved.display} is too large to edit as text.` };
      }
      throw err;
    }
    if (!opened) {
      return {
        success: false,
        error: `${lockedResolved.display} does not exist. Use write_file to create it.`
      };
    }
    const buffer = opened.buffer;
    if (!isProbablyText(buffer)) {
      return { success: false, error: `${lockedResolved.display} is binary; edit_file only works on text.` };
    }

    const before = buffer.toString('utf-8');
    const occurrences = _countOccurrences(before, args.oldText);
    if (occurrences === 0) {
      return {
        success: false,
        error: `That exact text is not in ${lockedResolved.display}. Read the file again and copy the target text verbatim, whitespace included.`
      };
    }
    if (occurrences > 1 && !args.replaceAll) {
      return {
        success: false,
        error: `"oldText" matches ${occurrences} times in ${lockedResolved.display}. `
          + 'Include enough surrounding lines to make it unique, or pass replaceAll=true to change every occurrence.'
      };
    }

    const after = args.replaceAll
      ? before.split(args.oldText).join(args.newText)
      : before.replace(args.oldText, args.newText);

    try {
      assertRootCapacity(workspaceId, Buffer.byteLength(after, 'utf-8'), buffer.length, lockedResolved.root);
    } catch (err) {
      if (err.code === 'EQUOTA') return { success: false, error: err.message, quota_exceeded: true };
      throw err;
    }

    const committed = await commitWorkspaceText(workspaceId, lockedResolved, after, opts);
    if (!committed.success) return committed;
    const { bytes, quota } = committed;
    const replaced = args.replaceAll ? occurrences : 1;
    return {
      success: true,
      path: lockedResolved.display,
      replacements: replaced,
      bytes,
      message: quota.ok
        ? `Replaced ${replaced} occurrence(s) in ${lockedResolved.display}.`
        : `Replaced ${replaced} occurrence(s) in ${lockedResolved.display}. ${quota.message}`,
      ...quotaResultFields(quota)
    };
  });
}

export { editFile };
