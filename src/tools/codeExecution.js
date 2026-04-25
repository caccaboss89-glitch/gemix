// src/tools/codeExecution.js
// Stateful Python execution tool, scoped to the current project. Files written
// to projects/<slug>/output/ are auto-buffered as attachments so the AI can
// deliver them via send_whatsapp_message / send_email afterwards.
//
// All the heavy lifting (snapshots, diffs, sandbox lifecycle, crash slot,
// auto-attach) lives in sandbox/projectRun.js so write_file/edit_file/bash
// can share the exact same pipeline.

const { runInProjectSandbox } = require('../sandbox/projectRun');

function _formatResult({ kernelResult, diff, durationMs, quotaWarning }) {
  const out = {
    success: kernelResult.status === 'ok',
    status: kernelResult.status,
    duration_ms: durationMs,
    stdout: kernelResult.stdout || '',
    stderr: kernelResult.stderr || '',
    output_truncated: !!kernelResult.truncated,
  };
  if (kernelResult.results.length > 0) out.last_expression = kernelResult.results.join('\n');
  if (kernelResult.error) out.error = kernelResult.error;
  if (kernelResult.traceback) out.traceback = kernelResult.traceback;
  if (diff.newFiles.length > 0) out.new_files = diff.newFiles;
  if (diff.modifiedFiles.length > 0) out.modified_files = diff.modifiedFiles;
  if (quotaWarning) out.quota_warning = quotaWarning;
  return out;
}

/**
 * `code_execution` tool entry-point.
 * @param {object} args { code, timeout_ms? }
 * @param {object} userCtx
 * @param {object} responseCtx
 */
async function codeExecutionTool(args, userCtx, responseCtx) {
  const code = args && args.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { success: false, error: 'Missing required argument "code".' };
  }

  const result = await runInProjectSandbox({
    userCtx,
    responseCtx,
    code,
    toolLabel: 'code_execution',
    timeoutMs: args.timeout_ms,
    crashPayload: { code_preview: String(code).slice(0, 400) },
    autoAttach: true,
  });

  if (result.error) return { success: false, error: result.error };
  return _formatResult(result);
}

module.exports = { codeExecutionTool };
