// src/tools/workspace/writeFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `write_file`: create or overwrite one file in `workspace/`.
//
// The write happens inside the container, not on the host bind mount, so the
// file lands owned by the sandbox user with the sandbox's own limits, and a
// symlink planted from inside cannot redirect a host-side write out of the
// tree. Content travels on stdin rather than in argv.
//
// Only `workspace/` is writable. `/attachments` is a read-only mount: to change
// a conversation file the model copies it across first.

import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWorkspaceQuota } from '../../sandbox/workspaceFs.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

/** `bash -c` script + "$1": the path never goes through shell interpolation. */
const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1"';

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

  const resolved = resolveAgentPath(workspaceId, raw);
  if (!resolved) return invalidPathError(raw);
  if (!resolved.writable) {
    return {
      success: false,
      error: `${resolved.display} is read-only. Copy it into workspace/ first, then write there.`
    };
  }

  const bytes = Buffer.byteLength(args.content, 'utf-8');

  return withWorkspaceLock(workspaceId, { ownerId: opts.lockOwnerId }, async () => {
    const run = await workspaceRuntime.execInWorkspace(workspaceId, {
      command: ['/bin/bash', '-c', WRITE_SCRIPT, 'write_file', resolved.containerPath],
      input: args.content
    });
    if (run.rc !== 0) {
      return {
        success: false,
        error: `Could not write ${resolved.display}: ${(run.stderr || run.stdout || `exit ${run.rc}`).trim().slice(0, 400)}`
      };
    }

    const quota = checkWorkspaceQuota(workspaceId);
    return {
      success: true,
      path: resolved.display,
      bytes,
      message: quota.ok
        ? `Wrote ${bytes} byte(s) to ${resolved.display}.`
        : `Wrote ${bytes} byte(s) to ${resolved.display}. ${quota.message}`,
      ...(quota.ok ? {} : { quota_exceeded: true, quota_mb: constants.WORKSPACE_QUOTA_MB })
    };
  }).catch((err) => {
    if (err.code === 'EWORKSPACEBUSY') return { success: false, error: err.message };
    throw err;
  });
}

export { writeFile };
