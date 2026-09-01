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
// and memory capped, egress only through the sandbox proxy (public internet
// only, never the LAN), and no credential of any kind in the environment. A
// command that needs a token does not get one — GemiX makes provider calls
// itself, through its own tools.
//
// Timeout: 60s by default, 300s ceiling. Output is captured and capped;
// a command that will run longer than the ceiling should be backgrounded. It
// survives nearby calls only until the container reaches its idle TTL.

import constants from '../../config/constants.js';
import workspaceRuntime from '../../sandbox/workspaceRuntime.js';
import { checkWritableQuotas } from '../../sandbox/workspaceFs.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { callTimeoutWithin } from '../../utils/turnBudget.js';
import { quotaResultFields, runWorkspaceMutation } from './mutation.js';

/**
 * @param {object} args
 * @param {string} args.command - a shell line, run with bash
 * @param {number} [args.timeoutSeconds]
 * @param {string} [args.workingDir] - a directory inside the namespace
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {string} [opts.lockOwnerId]
 * @param {import('../../utils/turnBudget.js').TurnBudget|null} [opts.budget]
 */
async function shell(args = {}, workspaceId, opts = {}) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return { success: false, error: 'Missing required argument "command".' };

  // The namespace root makes `workspace/a.txt` and `attachments/b.txt` mean
  // exactly the same paths here as in every filesystem tool and final reply.
  let workingDir = '/';
  if (typeof args.workingDir === 'string' && args.workingDir.trim()) {
    const resolved = resolveAgentPath(workspaceId, args.workingDir);
    if (!resolved) return invalidPathError(args.workingDir);
    workingDir = resolved.containerPath;
  }

  const requestedSec = Number(args.timeoutSeconds);
  const requestedMs = Number.isFinite(requestedSec) && requestedSec > 0
    ? requestedSec * 1000
    : constants.SHELL_TIMEOUT_DEFAULT_MS;
  const timeoutMs = callTimeoutWithin(
    Math.min(requestedMs, constants.SHELL_TIMEOUT_MAX_MS),
    opts.budget
  );
  const cappedSec = Math.round(timeoutMs / 1000);

  return runWorkspaceMutation(workspaceId, opts, async () => {
    const run = await workspaceRuntime.execInWorkspace(workspaceId, {
      command,
      timeoutMs,
      workingDir
    });

    const notes = [];
    if (run.timedOut) notes.push(`Killed after ${cappedSec}s. Background long work with nohup and poll it in a later call.`);
    if (run.truncated) notes.push('Output was truncated; only the tail is shown.');
    const quota = checkWritableQuotas(workspaceId);
    if (!quota.ok) notes.push(quota.message);
    const commandSucceeded = run.rc === 0 && !run.timedOut;

    return {
      success: commandSucceeded && quota.ok,
      exit_code: run.rc,
      timed_out: run.timedOut,
      output_truncated: run.truncated,
      duration_ms: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      ...quotaResultFields(quota),
      ...(commandSucceeded && quota.ok
        ? {}
        : { error: commandSucceeded ? quota.message : `Command exited with code ${run.rc}.` }),
      message: notes.join(' ') || `Exit ${run.rc} in ${run.durationMs} ms.`
    };
  });
}

export { shell };
