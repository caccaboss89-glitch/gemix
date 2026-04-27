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

// Injected once per kernel session. Monkeypatches builtins.open to deny writes
// outside the four authorized project subdirectories, matching write_file/edit_file rules.
const WRITE_GUARD_PREAMBLE = `\
if '_gemix_write_guard_active' not in globals():
    import builtins as _b_mod, os as _os_mod, pathlib as _pathlib_mod
    _GEMIX_ALLOWED_WRITE = (
        '/workspace/temp/',
        '/workspace/output/',
        '/workspace/code/',
    )
    def _gemix_guard_path(file, mode='r'):
        if not isinstance(file, (_os_mod.PathLike, str, bytes)):
            return
        try:
            _p = _os_mod.path.realpath(
                file.decode('utf-8', 'replace') if isinstance(file, bytes) else str(file)
            )
        except Exception:
            _p = str(file)
        if any(c in str(mode) for c in 'wax+') and _p.startswith('/workspace/'):
            if not any(_p.startswith(d) for d in _GEMIX_ALLOWED_WRITE):
                raise PermissionError(
                    f'GemiX sandbox: write denied outside authorized dirs.\\n'
                    f'Attempted path: {_p}\\n'
                    f'Allowed write dirs: temp/, output/, code/'
                )
    _orig_builtin_open = _b_mod.open
    def _gemix_protected_open(file, mode='r', *args, **kwargs):
        _gemix_guard_path(file, mode)
        return _orig_builtin_open(file, mode, *args, **kwargs)
    _orig_os_open = _os_mod.open
    def _gemix_protected_os_open(file, flags, *args, **kwargs):
        _write_flags = (
            getattr(_os_mod, 'O_WRONLY', 0)
            | getattr(_os_mod, 'O_RDWR', 0)
            | getattr(_os_mod, 'O_APPEND', 0)
            | getattr(_os_mod, 'O_CREAT', 0)
            | getattr(_os_mod, 'O_TRUNC', 0)
        )
        _mode = 'r'
        if flags & _write_flags:
            _mode = 'w'
        _gemix_guard_path(file, _mode)
        return _orig_os_open(file, flags, *args, **kwargs)
    _orig_pathlib_open = _pathlib_mod.Path.open
    def _gemix_path_open(self, mode='r', *args, **kwargs):
        _gemix_guard_path(self, mode)
        return _orig_pathlib_open(self, mode, *args, **kwargs)
    _orig_write_text = _pathlib_mod.Path.write_text
    def _gemix_write_text(self, data, *args, **kwargs):
        _gemix_guard_path(self, 'w')
        return _orig_write_text(self, data, *args, **kwargs)
    _orig_write_bytes = _pathlib_mod.Path.write_bytes
    def _gemix_write_bytes(self, data, *args, **kwargs):
        _gemix_guard_path(self, 'wb')
        return _orig_write_bytes(self, data, *args, **kwargs)
    _b_mod.open = _gemix_protected_open
    _os_mod.open = _gemix_protected_os_open
    _pathlib_mod.Path.open = _gemix_path_open
    _pathlib_mod.Path.write_text = _gemix_write_text
    _pathlib_mod.Path.write_bytes = _gemix_write_bytes
    _gemix_write_guard_active = True
`;

const _ALLOWED_WRITE_SUBDIRS = ['temp/', 'output/', 'code/'];

function _formatResult({ kernelResult, diff, durationMs, quotaWarning, projectName }) {
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

  // Post-execution write violation check (defense-in-depth: catches os.open() bypasses)
  if (projectName) {
    const _prefix = `projects/${projectName}/`;
    const _allFiles = [...(diff.newFiles || []), ...(diff.modifiedFiles || [])];
    const _violations = _allFiles.filter(f => {
      if (f.escaped) return false;
      const rel = (f.path || '').startsWith(_prefix) ? f.path.slice(_prefix.length) : null;
      return rel !== null && !_ALLOWED_WRITE_SUBDIRS.some(p => rel.startsWith(p));
    });
    if (_violations.length > 0) {
      out.write_violations = _violations.map(f => f.path);
      hints.push(`Write violation: ${_violations.length} file(s) created/modified outside authorized dirs (temp/, output/, code/): ${_violations.map(f => f.path).join(', ')}.`);
    }
  }
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
    code: WRITE_GUARD_PREAMBLE + code,
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
