// src/tools/codeExecution.js
// Stateful Python execution tool, scoped to the current project. Files written
// to projects/<slug>/output/ are auto-buffered as attachments so the AI can
// deliver them via send_whatsapp_message / send_email afterwards.
//
// All the heavy lifting (snapshots, diffs, sandbox lifecycle, crash slot,
// auto-attach) lives in sandbox/projectRun.js so write_file/edit_file/bash
// can share the exact same pipeline.

const { runInProjectSandbox } = require('../sandbox/projectRun');
const { logToolExecution } = require('../utils/executionLogger');

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

  // Compact human-readable hint so the AI can decide the next step (deliver
  // attachments / fix error / cleanup) without re-parsing the full structure.
  const attached = (diff.newFiles || []).filter(f => f.auto_attached);
  const escaped = [...(diff.newFiles || []), ...(diff.modifiedFiles || [])].filter(f => f.escaped);
  const hints = [];
  if (out.status === 'timeout') hints.push('Execution timed out — split the work into smaller steps or raise timeout_ms.');
  else if (out.status === 'error') hints.push('Python error: read the traceback and fix the code before retrying.');
  if (attached.length > 0) {
    hints.push(`${attached.length} file(s) under output/ were auto-attached. Use send_whatsapp_message (or send_email / Discord) with includeAttachments=true to deliver them.`);
  }
  if (escaped.length > 0) {
    hints.push(`${escaped.length} file(s) were rejected as symlink escapes — do not try to leak read-only mounts via output/.`);
  }
  if (out.output_truncated) hints.push('Output was truncated; redirect verbose data to a file under temp/ instead of printing.');
  if (hints.length > 0) out.message_for_ai = hints.join(' ');
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

  if (result.error) {
    logToolExecution({
      tool: 'code_execution',
      input: { code, timeout_ms: args.timeout_ms },
      output: { success: false, error: result.error },
      meta: {
        user: {
          id: userCtx.userId || null,
          platform: userCtx.platform || null,
          chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null,
        },
      },
    });
    return { success: false, error: result.error };
  }

  const formatted = _formatResult(result);
  logToolExecution({
    tool: 'code_execution',
    input: { code, timeout_ms: args.timeout_ms },
    output: formatted,
    meta: {
      project: result.projectName,
      duration_ms: result.durationMs,
      user: {
        id: userCtx.userId || null,
        platform: userCtx.platform || null,
        chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null,
      },
    },
  });
  return formatted;
}

module.exports = { codeExecutionTool };
