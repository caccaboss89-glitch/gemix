// src/tools/workspace/mutation.js
//
// Shared mutation boundary for workspace tools: lock error normalization,
// atomic text replacement inside the container, and quota-result shaping.

import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWorkspaceQuota } from '../../sandbox/workspaceFs.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

const ATOMIC_WRITE_SCRIPT = [
  'set -efu',
  'dest="$1"',
  'allowed_root="${2:-/workspace}"',
  'dir="$(dirname -- "$dest")"',
  'root_real="$(realpath -e -- "$allowed_root")"',
  'case "$dest" in "$allowed_root"/*) ;; *) echo "destination is outside the workspace" >&2; exit 73 ;; esac',
  'check_parent() {',
  '  relative="${dir#"$allowed_root"}"',
  '  old_ifs="$IFS"; IFS="/"; set -- $relative; IFS="$old_ifs"',
  '  current="$allowed_root"',
  '  for component do',
  '    [ -n "$component" ] || continue',
  '    current="$current/$component"',
  '    if [ -L "$current" ]; then echo "symbolic-link parent refused: $current" >&2; exit 73; fi',
  '  done',
  '  parent_real="$(realpath -m -- "$dir")"',
  '  case "$parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "parent resolves outside the workspace" >&2; exit 73 ;; esac',
  '}',
  'check_parent',
  'mkdir -p -- "$dir"',
  'check_parent',
  'tmp="$(mktemp "$dir/.gemix-write.XXXXXX")"',
  'cleanup() { rm -f -- "$tmp"; }',
  'trap cleanup EXIT HUP INT TERM',
  'cat > "$tmp"',
  'if [ -f "$dest" ]; then chmod --reference="$dest" "$tmp"; else chmod 0644 "$tmp"; fi',
  'check_parent',
  // Same-directory rename is atomic. -T also replaces a symlink entry instead
  // of treating a symlink-to-directory as a destination directory.
  'mv -fT -- "$tmp" "$dest"',
  'trap - EXIT HUP INT TERM'
].join('\n');

async function runWorkspaceMutation(workspaceId, opts = {}, fn) {
  try {
    return await withWorkspaceLock(workspaceId, {
      ownerId: opts.lockOwnerId,
      signal: opts.budget?.signal
    }, fn);
  } catch (err) {
    if (err.code === 'EWORKSPACEBUSY') return { success: false, error: err.message };
    throw err;
  }
}

/**
 * @param {string} workspaceId
 * @param {object} resolved - a path already resolved under the mutation lock
 * @param {string} content
 * @param {object} [opts]
 * @param {boolean} [opts.isAdmin] - exempt from the concurrent-container cap
 */
async function commitWorkspaceText(workspaceId, resolved, content, opts = {}) {
  const run = await workspaceRuntime.execInWorkspace(workspaceId, {
    command: ['/bin/bash', '-c', ATOMIC_WRITE_SCRIPT, 'workspace_text_write', resolved.containerPath, '/workspace'],
    input: content,
    isAdmin: opts.isAdmin
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
