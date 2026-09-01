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
 * What stopped a command the sandbox killed, phrased so the model stops looking
 * for a fault in the command itself. A timeout is not in here: a call that ran
 * to its deadline is reported as one instead.
 *
 * @param {number} rc - exit code, 128 + signal number for a death by signal
 * @param {'oom'|'container-stopped'|null} [killCause] - what the runtime found
 *   when it asked Docker why a SIGKILL happened
 * @returns {string|null} - null when the command chose its own exit code
 */
function killNote(rc, killCause) {
  // SIGKILL: nothing in the container survives it, so a command still working
  // simply stops, with no failure of its own to report.
  if (rc === 137) {
    if (killCause === 'container-stopped') {
      return 'The workspace container stopped mid-command, which kills everything inside it. Nothing is wrong '
        + 'with the command and running it again will not help until the sandbox is healthy: say the workspace '
        + 'is unavailable rather than reading anything into it.';
    }
    if (killCause === 'oom') {
      return `Killed by the ${constants.SANDBOX_MEMORY_MB} MB container memory cap. Work in smaller pieces, `
        + 'stream instead of loading whole files, and stop anything left running in the background.';
    }
    // Docker reports OOMKilled for the container, not for one exec'd command,
    // so a single greedy command reaching the cap arrives here too.
    return 'Killed with SIGKILL from inside the container, so it never reached its own error handling. The quota '
      + 'monitor does that when a root is over its limit, and the kernel does it when one command asks for too '
      + 'much memory at once: free space if a quota note says you are over, otherwise work in smaller pieces.';
  }
  // SIGXFSZ, from the per-file ceiling every command runs under.
  if (rc === 153) {
    return `Killed writing a single file past the ${constants.WORKSPACE_QUOTA_LABEL} per-file ceiling.`;
  }
  return null;
}

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
    const resolved = resolveAgentPath(workspaceId, args.workingDir, opts);
    if (!resolved) return invalidPathError(args.workingDir, opts);
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
      workingDir,
      mountSkills: Boolean(opts.skills)
    });

    const notes = [];
    if (run.timedOut) notes.push(`Killed after ${cappedSec}s. Background long work with nohup and poll it in a later call.`);
    else {
      const killed = killNote(run.rc, run.killCause);
      if (killed) notes.push(killed);
    }
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
