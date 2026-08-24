// src/tools/workspace/mutation.js
//
// Shared mutation boundary for workspace tools: lock error normalization,
// atomic text replacement inside the container, and quota-result shaping.

import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWorkspaceQuota } from '../../sandbox/workspaceFs.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

const ATOMIC_WRITE_SCRIPT = [
  'set -eu',
  'dest="$1"',
  'dir="$(dirname -- "$dest")"',
  'mkdir -p -- "$dir"',
  // The prefix is private to this writer. A previous SIGKILL can bypass the
  // trap, so the next serialized mutation removes any abandoned temporary.
  'find "$dir" -maxdepth 1 -type f -name ".gemix-write.*" -delete',
  'tmp="$(mktemp "$dir/.gemix-write.XXXXXX")"',
  'cleanup() { rm -f -- "$tmp"; }',
  'trap cleanup EXIT HUP INT TERM',
  'cat > "$tmp"',
  'if [ -f "$dest" ]; then chmod --reference="$dest" "$tmp"; else chmod 0644 "$tmp"; fi',
  // Same-directory rename is atomic. -T also replaces a symlink entry instead
  // of treating a symlink-to-directory as a destination directory.
  'mv -fT -- "$tmp" "$dest"',
  'trap - EXIT HUP INT TERM'
].join('\n');

async function runWorkspaceMutation(workspaceId, opts = {}, fn) {
  try {
    return await withWorkspaceLock(workspaceId, { ownerId: opts.lockOwnerId }, fn);
  } catch (err) {
    if (err.code === 'EWORKSPACEBUSY') return { success: false, error: err.message };
    throw err;
  }
}

async function commitWorkspaceText(workspaceId, resolved, content) {
  const run = await workspaceRuntime.execInWorkspace(workspaceId, {
    command: ['/bin/bash', '-c', ATOMIC_WRITE_SCRIPT, 'workspace_text_write', resolved.containerPath],
    input: content
  });
  if (run.rc !== 0) {
    return {
      success: false,
      error: `Could not write ${resolved.display}: ${(run.stderr || run.stdout || `exit ${run.rc}`).trim().slice(0, 400)}`
    };
  }
  return {
    success: true,
    bytes: Buffer.byteLength(content, 'utf-8'),
    quota: checkWorkspaceQuota(workspaceId)
  };
}

function quotaResultFields(quota) {
  return quota.ok
    ? {}
    : { quota_exceeded: true, quota_mb: constants.WORKSPACE_QUOTA_MB };
}

export {
  ATOMIC_WRITE_SCRIPT,
  commitWorkspaceText,
  quotaResultFields,
  runWorkspaceMutation
};
