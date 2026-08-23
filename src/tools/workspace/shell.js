// src/tools/workspace/shell.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are plain objects the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// `shell`: run a command in the workspace container.
//
// This is where arbitrary model-authored code runs, which is exactly why it
// runs in the container and nowhere else: capabilities dropped, non-root, pid
// and memory capped, egress only through the residential proxy, and no
// credential of any kind in the environment. A command that needs a token does
// not get one — GemiX makes provider calls itself, through its own tools.
//
// Timeout: 60s by default, 300s ceiling. Output is captured and capped;
// a command that will run longer than the ceiling should be backgrounded, and
// the container survives between calls so it will still be running next time.

import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWorkspaceQuota } from '../../sandbox/workspaceFs.js';
import { ROOT, invalidPathError, resolveAgentPath, toContainerPath } from '../../sandbox/workspacePaths.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

/**
 * @param {object} args
 * @param {string} args.command - a shell line, run with bash
 * @param {number} [args.timeoutSeconds]
 * @param {string} [args.workingDir] - a directory inside the namespace
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.lockOwnerId]
 */
async function shell(args = {}, workspaceId, opts = {}) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return { success: false, error: 'Missing required argument "command".' };

  let workingDir = toContainerPath(ROOT.WORKSPACE, '');
  if (typeof args.workingDir === 'string' && args.workingDir.trim()) {
    const resolved = resolveAgentPath(workspaceId, args.workingDir);
    if (!resolved) return invalidPathError(args.workingDir);
    workingDir = resolved.containerPath;
  }

  const requestedSec = Number(args.timeoutSeconds);
  const timeoutMs = Number.isFinite(requestedSec) && requestedSec > 0
    ? requestedSec * 1000
    : constants.SHELL_TIMEOUT_DEFAULT_MS;
  const cappedSec = Math.round(Math.min(timeoutMs, constants.SHELL_TIMEOUT_MAX_MS) / 1000);

  return withWorkspaceLock(workspaceId, { ownerId: opts.lockOwnerId }, async () => {
    const run = await workspaceRuntime.execInWorkspace(workspaceId, {
      command,
      timeoutMs,
      workingDir
    });

    const notes = [];
    if (run.timedOut) notes.push(`Killed after ${cappedSec}s. Background long work with nohup and poll it in a later call.`);
    if (run.truncated) notes.push('Output was truncated; only the tail is shown.');
    const quota = checkWorkspaceQuota(workspaceId);
    if (!quota.ok) notes.push(quota.message);

    return {
      success: run.rc === 0 && !run.timedOut,
      exit_code: run.rc,
      timed_out: run.timedOut,
      duration_ms: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      ...(quota.ok ? {} : { quota_exceeded: true, quota_mb: constants.WORKSPACE_QUOTA_MB }),
      ...(run.rc === 0 && !run.timedOut ? {} : { error: `Command exited with code ${run.rc}.` }),
      message: notes.join(' ') || `Exit ${run.rc} in ${run.durationMs} ms.`
    };
  }).catch((err) => {
    if (err.code === 'EWORKSPACEBUSY') return { success: false, error: err.message };
    throw err;
  });
}

export { shell };
