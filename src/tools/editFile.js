// src/tools/editFile.js
// Find-and-replace edit on an existing file inside the current project.
// Routed through the sandbox kernel for the same reason as writeFile.
//
// Semantics:
//   - old_string MUST be unique in the file unless replace_all=true.
//   - If old_string is empty → error (use write_file to create a fresh file).
//   - File MUST live under /workspace/{temp|output|code}/.

const path = require('path');
const { runInProjectSandbox } = require('../sandbox/projectRun');
const { isPathAllowed, getProjectRoot } = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');
const { logToolExecution } = require('../utils/executionLogger');

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const NON_READABLE_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.wav', '.mp4', '.mov', '.zip', '.tar', '.gz', '.7z', '.rar', '.xlsx', '.docx', '.pptx', '.exe', '.dll', '.bin', '.so', '.jar', '.class', '.pyc', '.db', '.sqlite', '.iso', '.dmg']);

function _toContainerPath(absHostPath, projectDir) {
  const rel = path.relative(projectDir, absHostPath).split(path.sep).join('/');
  return `/workspace/${rel}`;
}

/**
 * Build a Python snippet that performs the edit atomically:
 *   1. Read file as bytes, decode utf-8 with 'replace' fallback.
 *   2. Validate uniqueness when replace_all=False.
 *   3. Replace and write back.
 *   4. Print a structured one-line summary the JS side parses.
 */
function _buildPython(containerPath, oldB64, newB64, replaceAll, startLine = null, endLine = null) {
  const safePath = JSON.stringify(containerPath);
  const safeOld = JSON.stringify(oldB64);
  const safeNew = JSON.stringify(newB64);
  const allFlag = replaceAll ? 'True' : 'False';
  const sLine = startLine === null ? 'None' : Math.max(1, parseInt(startLine));
  const eLine = endLine === null ? 'None' : Math.max(1, parseInt(endLine));

  return [
    'import base64, json, os',
    `_p = ${safePath}`,
    `_old = base64.b64decode(${safeOld}).decode("utf-8")`,
    `_new = base64.b64decode(${safeNew}).decode("utf-8")`,
    `_replace_all = ${allFlag}`,
    `_sl = ${sLine}`,
    `_el = ${eLine}`,
    'if not os.path.exists(_p):',
    '    _report = {"ok": False, "reason": "file_not_found"}',
    'else:',
    '    with open(_p, "rb") as _f: _raw = _f.read()',
    '    try: _text = _raw.decode("utf-8")',
    '    except UnicodeDecodeError:',
    '        _report = {"ok": False, "reason": "not_utf8"}',
    '    else:',
    '        if _sl is not None or _el is not None:',
    '            _lines = _text.splitlines(keepends=True)',
    '            _start_idx = (_sl - 1) if _sl is not None else 0',
    '            _end_idx = _el if _el is not None else len(_lines)',
    '            _target_block = "".join(_lines[_start_idx:_end_idx])',
    '            _n = _target_block.count(_old)',
    '            if _n == 0:',
    '                _report = {"ok": False, "reason": "old_string_not_found_in_range"}',
    '            elif _n > 1 and not _replace_all:',
    '                _report = {"ok": False, "reason": "old_string_not_unique_in_range", "occurrences": _n}',
    '            else:',
    '                _replaced = _target_block.replace(_old, _new) if _replace_all else _target_block.replace(_old, _new, 1)',
    '                _out = "".join(_lines[:_start_idx]) + _replaced + "".join(_lines[_end_idx:])',
    '                _data = _out.encode("utf-8")',
    '                with open(_p, "wb") as _f: _f.write(_data)',
    '                _report = {"ok": True, "occurrences": _n if _replace_all else 1, "bytes_written": len(_data)}',
    '        else:',
    '            _n = _text.count(_old)',
    '            if _n == 0:',
    '                _report = {"ok": False, "reason": "old_string_not_found"}',
    '            elif _n > 1 and not _replace_all:',
    '                _report = {"ok": False, "reason": "old_string_not_unique", "occurrences": _n}',
    '            else:',
    '                _out = _text.replace(_old, _new) if _replace_all else _text.replace(_old, _new, 1)',
    '                _data = _out.encode("utf-8")',
    '                with open(_p, "wb") as _f: _f.write(_data)',
    '                _report = {"ok": True, "occurrences": _n if _replace_all else 1, "bytes_written": len(_data)}',
    'print(json.dumps(_report))',
  ].join('\n');
}

async function editFileTool(args, userCtx, responseCtx) {
  const rawPath = args && args.path;
  const oldStr = args && args.old_string;
  const newStr = args && args.new_string;
  const replaceAll = Boolean(args && args.replace_all);
  const startLine = args && args.start_line !== undefined ? Number(args.start_line) : null;
  const endLine = args && args.end_line !== undefined ? Number(args.end_line) : null;

  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { success: false, error: 'Missing required argument "path".' };
  }
  if (typeof oldStr !== 'string' || oldStr.trim().length === 0) {
    return { success: false, error: 'old_string must be a non-empty string and cannot be only whitespace. Use write_file to create a new file or provide context.' };
  }
  if (typeof newStr !== 'string') {
    return { success: false, error: 'new_string must be a string (use empty string to delete).' };
  }
  if (oldStr === newStr) {
    return { success: false, error: 'old_string and new_string are identical (no-op).' };
  }
  if (Buffer.byteLength(oldStr, 'utf-8') > MAX_EDIT_BYTES || Buffer.byteLength(newStr, 'utf-8') > MAX_EDIT_BYTES) {
    return { success: false, error: 'old_string / new_string too large.' };
  }

  const currentProject = await getCurrentProject(userCtx);
  if (!currentProject) {
    return { success: false, error: 'No project is currently selected. Run `gemix-project create` (new project) or `gemix-project switch <slug>` (existing) via bash first.' };
  }

  const auth = isPathAllowed(userCtx, rawPath, { op: 'write', currentProject });
  if (!auth.ok) {
    return { success: false, error: `edit_file refused: ${auth.reason}` };
  }

  const ext = path.extname(auth.absPath).toLowerCase();
  if (NON_READABLE_EXTS.has(ext)) {
    return { success: false, error: `edit_file: files with extension "${ext}" are binary or not supported for direct text editing. Use other specialized tools or scripts to handle them.` };
  }

  const projectDir = getProjectRoot(userCtx, currentProject);
  const containerPath = _toContainerPath(auth.absPath, projectDir);

  const code = _buildPython(
    containerPath,
    Buffer.from(oldStr, 'utf-8').toString('base64'),
    Buffer.from(newStr, 'utf-8').toString('base64'),
    replaceAll,
    startLine,
    endLine,
  );

  const result = await runInProjectSandbox({
    userCtx,
    responseCtx,
    code,
    toolLabel: 'edit_file',
    timeoutMs: 15_000,
    crashPayload: { target_path: auth.absPath, replace_all: replaceAll },
    autoAttach: true,
    requireProject: true,
  });

  if (result.error) {
    const errorOut = { success: false, error: result.error };
    logToolExecution({
      tool: 'edit_file',
      input: { path: rawPath, replace_all: replaceAll },
      output: errorOut,
      meta: { user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }

  const k = result.kernelResult;
  if (k.status !== 'ok') {
    const errorOut = {
      success: false,
      error: k.error || 'edit_file failed inside sandbox.',
      stderr: k.stderr || '',
      traceback: k.traceback || null,
    };
    logToolExecution({
      tool: 'edit_file',
      input: { path: rawPath, replace_all: replaceAll },
      output: errorOut,
      meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }

  // Parse the final JSON line printed by the snippet.
  const lines = (k.stdout || '').trim().split(/\r?\n/);
  let report = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try { report = JSON.parse(ln); break; } catch { /* try next */ }
  }
  if (!report) {
    const errorOut = { success: false, error: 'edit_file: could not parse sandbox report.', stdout: k.stdout || '' };
    logToolExecution({
      tool: 'edit_file',
      input: { path: rawPath, replace_all: replaceAll },
      output: errorOut,
      meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }
  if (!report.ok) {
    const reasonMap = {
      file_not_found: 'File does not exist. Use write_file to create it first.',
      not_utf8: 'File is not UTF-8 — edit_file only supports text files.',
      old_string_not_found: 'old_string not found in the file.',
      old_string_not_found_in_range: `old_string not found within lines ${startLine} and ${endLine}.`,
      old_string_not_unique: `old_string occurs ${report.occurrences} times — set replace_all=true or provide more surrounding context.`,
      old_string_not_unique_in_range: `old_string occurs ${report.occurrences} times within lines ${startLine} and ${endLine} — set replace_all=true or provide more surrounding context.`,
    };
    const errorOut = {
      success: false,
      error: reasonMap[report.reason] || `edit_file failed: ${report.reason}`,
      occurrences: report.occurrences,
    };
    logToolExecution({
      tool: 'edit_file',
      input: { path: rawPath, replace_all: replaceAll },
      output: errorOut,
      meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }

  const hints = ['File edited successfully.'];
  if (result.sandboxRestarted) {
    hints.push('⚠️ The Python kernel was RESTARTED because it was dead or hung. All your previous variables and state are LOST. You must re-import modules and re-declare variables.');
  }
  if (result.bgTaskActive) {
    hints.push('⚠️ WARNING: A background task is currently running in this project. Foreground execution may cause race conditions or corrupt state if they modify the same files.');
  }

  const out = {
    success: true,
    message: hints.join(' '),
    path: `/workspace/${path.relative(projectDir, auth.absPath).split(path.sep).join('/')}`,
    occurrences_replaced: report.occurrences,
    bytes_written: report.bytes_written,
    duration_ms: result.durationMs,
  };
  if (result.diff.modifiedFiles.length > 0) out.modified_files = result.diff.modifiedFiles;
  if (result.quotaWarning) out.quota_warning = result.quotaWarning;
  logToolExecution({
    tool: 'edit_file',
    input: { path: rawPath, replace_all: replaceAll },
    output: out,
    meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
  });
  return out;
}

module.exports = { editFileTool };
