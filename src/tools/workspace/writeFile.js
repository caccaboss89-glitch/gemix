// src/tools/workspace/writeFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `write_file`: create or overwrite one file in a writable root.
//
// The write happens inside the container, not on the host bind mount, so the
// file lands owned by the sandbox user with the sandbox's own limits, and a
// symlink planted from inside cannot redirect a host-side write out of the
// tree. Content travels on stdin rather than in argv.
//
// `workspace/` is the only writable root. `/attachments` and `/skills` are
// read-only mounts: to change a file from either, the model copies it across
// first.

import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { statAgentFile } from '../../sandbox/hostFileGateway.js';
import { assertRootCapacity } from '../../sandbox/workspaceFs.js';
import {
  commitWorkspaceText,
  quotaResultFields,
  runWorkspaceMutation
} from './mutation.js';

/**
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.content
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.lockOwnerId]
 */
async function writeFile(args = {}, workspaceId, opts = {}) {
  const raw = typeof args.path === 'string' ? args.path : '';
  if (!raw.trim()) return { success: false, error: 'Missing required argument "path".' };
  if (typeof args.content !== 'string') {
    return { success: false, error: 'Missing required argument "content" (pass an empty string for an empty file).' };
  }

  const resolved = resolveAgentPath(workspaceId, raw, { ...opts, forWrite: true });
  if (!resolved) return invalidPathError(raw, opts);
  if (!resolved.writable) {
    return {
      success: false,
      error: `${resolved.display} is read-only. Copy it into workspace/ first, then write there.`
    };
  }

  return runWorkspaceMutation(workspaceId, opts, async () => {
    // Resolve again under the mutation lock so a parent cannot be exchanged
    // for a symlink between validation and serialization.
    const lockedResolved = resolveAgentPath(workspaceId, raw, { ...opts, forWrite: true });
    if (!lockedResolved || !lockedResolved.writable) return invalidPathError(raw, opts);
    const current = statAgentFile(workspaceId, lockedResolved.display);
    try {
      assertRootCapacity(
        workspaceId,
        Buffer.byteLength(args.content, 'utf-8'),
        current?.stat?.size || 0,
        lockedResolved.root
      );
    } catch (err) {
      if (err.code === 'EQUOTA') return { success: false, error: err.message, quota_exceeded: true };
      throw err;
    }
    const committed = await commitWorkspaceText(workspaceId, lockedResolved, args.content, opts);
    if (!committed.success) return committed;
    const { bytes, quota } = committed;
    return {
      success: true,
      path: lockedResolved.display,
      bytes,
      message: quota.ok
        ? `Wrote ${bytes} byte(s) to ${lockedResolved.display}.`
        : `Wrote ${bytes} byte(s) to ${lockedResolved.display}. ${quota.message}`,
      ...quotaResultFields(quota)
    };
  });
}

export { writeFile };
