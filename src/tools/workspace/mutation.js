// src/tools/workspace/mutation.js
//
// Shared mutation boundary for workspace tools: lock error normalization,
// atomic text replacement inside the container, and quota-result shaping.

import crypto from 'node:crypto';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkRootQuota } from '../../sandbox/workspaceFs.js';
import { toContainerPath } from '../../sandbox/workspacePaths.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('WorkspaceMutation');

const ATOMIC_WRITE_SCRIPT = [
  'set -efu',
  'dest="$1"',
  'allowed_root="${2:-/workspace}"',
  'backup="$3"',
  '[ -n "$backup" ] || { echo "missing rollback path" >&2; exit 73; }',
  'dir="$(dirname -- "$dest")"',
  'root_real="$(realpath -e -- "$allowed_root")"',
  'case "$dest" in "$allowed_root"/*) ;; *) echo "destination is outside $allowed_root" >&2; exit 73 ;; esac',
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
  '  case "$parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "parent resolves outside $allowed_root" >&2; exit 73 ;; esac',
  '}',
  'check_parent',
  'mkdir -p -- "$dir"',
  'check_parent',
  '[ ! -L "$dest" ] || { echo "symbolic-link destination refused: $dest" >&2; exit 73; }',
  'mkdir -p -- "$(dirname -- "$backup")"',
  'rm -f -- "$backup"',
  'had_dest=0',
  'if [ -f "$dest" ]; then cp --reflink=auto -- "$dest" "$backup"; had_dest=1; fi',
  'tmp="$(mktemp "$dir/.gemix-write.XXXXXX")"',
  'committed=0',
  'cleanup() { rm -f -- "$tmp"; [ "$committed" -eq 1 ] || rm -f -- "$backup"; }',
  'trap cleanup EXIT HUP INT TERM',
  'cat > "$tmp"',
  'if [ -f "$dest" ]; then chmod --reference="$dest" "$tmp"; else chmod 0644 "$tmp"; fi',
  'check_parent',
  // Same-directory rename is atomic. -T also replaces a symlink entry instead
  // of treating a symlink-to-directory as a destination directory.
  'mv -fT -- "$tmp" "$dest"',
  'committed=1',
  'trap - EXIT HUP INT TERM',
  'printf "%s" "$had_dest"'
].join('\n');

const ROLLBACK_WRITE_SCRIPT = [
  'set -efu',
  'dest="$1"',
  'allowed_root="$2"',
  'backup="$3"',
  'had_dest="$4"',
  'root_real="$(realpath -e -- "$allowed_root")"',
  'case "$dest" in "$allowed_root"/*) ;; *) echo "destination is outside $allowed_root" >&2; exit 73 ;; esac',
  'dir="$(dirname -- "$dest")"',
  'parent_real="$(realpath -m -- "$dir")"',
  'case "$parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "parent resolves outside $allowed_root" >&2; exit 73 ;; esac',
  'if [ "$had_dest" = "1" ]; then',
  '  [ -f "$backup" ] && [ ! -L "$backup" ] || { echo "rollback copy is missing" >&2; exit 74; }',
  '  mv -fT -- "$backup" "$dest"',
  'else',
  '  rm -f -- "$dest" "$backup"',
  'fi'
].join('\n');

const FINALIZE_WRITE_SCRIPT = 'set -efu\nrm -f -- "$1"';

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
 * @param {boolean} [opts.skills] - whether this chat has the skill library, and
 *   so whether its container mounts it. A property of the chat, not of the path
 *   being written — writes only ever land in `workspace/` — but the same
 *   container serves later calls that do read from the library.
 */
async function commitWorkspaceText(workspaceId, resolved, content, opts = {}) {
  // The allowed root is the one the path resolved into, which the caller has
  // already checked is writable: the script refuses anything outside it.
  const allowedRoot = toContainerPath(resolved.root, '');
  const backupPath = `/var/lib/gemix-workspace/.rollback/${crypto.randomBytes(16).toString('hex')}`;
  const run = await workspaceRuntime.execInWorkspace(workspaceId, {
    command: [
      '/bin/bash', '-c', ATOMIC_WRITE_SCRIPT, 'workspace_text_write',
      resolved.containerPath, allowedRoot, backupPath
    ],
    input: content,
    mountSkills: Boolean(opts.skills)
  });
  if (run.rc !== 0) {
    return {
      success: false,
      error: `Could not write ${resolved.display}: ${(run.stderr || run.stdout || `exit ${run.rc}`).trim().slice(0, 400)}`
    };
  }
  const marker = run.stdout.trim();
  const transactionPrepared = marker === '0' || marker === '1';
  const quota = typeof opts.checkQuota === 'function'
    ? opts.checkQuota(workspaceId, resolved.root)
    : checkRootQuota(workspaceId, resolved.root);
  if (!quota.ok) {
    if (!transactionPrepared) {
      return {
        success: false,
        error: `${quota.message} The write could not be rolled back because its transaction marker was missing.`,
        rollback_failed: true,
        ...quotaResultFields(quota)
      };
    }
    const rollback = await workspaceRuntime.execInWorkspace(workspaceId, {
      command: [
        '/bin/bash', '-c', ROLLBACK_WRITE_SCRIPT, 'workspace_text_rollback',
        resolved.containerPath, allowedRoot, backupPath, marker
      ],
      mountSkills: Boolean(opts.skills)
    });
    if (rollback.rc !== 0) {
      return {
        success: false,
        error: `${quota.message} Rollback also failed: ${(rollback.stderr || rollback.stdout || `exit ${rollback.rc}`).trim().slice(0, 400)}`,
        rollback_failed: true,
        ...quotaResultFields(quota)
      };
    }
    return {
      success: false,
      error: `${quota.message} The write was rolled back.`,
      rolled_back: true,
      ...quotaResultFields(quota)
    };
  }

  if (transactionPrepared) {
    const finalized = await workspaceRuntime.execInWorkspace(workspaceId, {
      command: ['/bin/bash', '-c', FINALIZE_WRITE_SCRIPT, 'workspace_text_finalize', backupPath],
      mountSkills: Boolean(opts.skills)
    });
    if (finalized.rc !== 0) {
      log.warn(`Could not remove private rollback copy for ${resolved.display}: ${finalized.stderr || finalized.stdout}`);
    }
  }
  return { success: true, bytes: Buffer.byteLength(content, 'utf-8'), quota };
}

function quotaResultFields(quota) {
  if (quota.ok) return {};
  if (quota.inventoryComplete === false || quota.code === 'EINVENTORY') {
    return { inventory_incomplete: true };
  }
  return {
    quota_exceeded: true,
    ...(Number.isFinite(quota.quotaMb) ? { quota_mb: quota.quotaMb } : {})
  };
}

export {
  ATOMIC_WRITE_SCRIPT,
  ROLLBACK_WRITE_SCRIPT,
  commitWorkspaceText,
  quotaResultFields,
  runWorkspaceMutation
};
