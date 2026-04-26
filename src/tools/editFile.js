// src/tools/editFile.js
// Find-and-replace edit on an existing file inside the current project.
// Routed through the sandbox kernel for the same reason as writeFile.
//
// Semantics:
//   - old_string MUST be unique in the file unless replace_all=true.
//   - If old_string is empty → error (use write_file to create a fresh file).
//   - File MUST live under projects/<current>/{figures|temp|output|code}/.

const path = require('path');
const { runInProjectSandbox } = require('../sandbox/projectRun');
const { isPathAllowed, getProjectRoot } = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');

const MAX_EDIT_BYTES = 5 * 1024 * 1024;

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
function _buildPython(containerPath, oldB64, newB64, replaceAll) {
  const safePath = JSON.stringify(containerPath);
  const safeOld = JSON.stringify(oldB64);
  const safeNew = JSON.stringify(newB64);
  const allFlag = replaceAll ? 'True' : 'False';
  return [
    'import base64, json, os, sys',
    `_p = ${safePath}`,
    `_old = base64.b64decode(${safeOld}).decode("utf-8")`,
    `_new = base64.b64decode(${safeNew}).decode("utf-8")`,
    `_replace_all = ${allFlag}`,
    'if not os.path.exists(_p):',
    '    print(json.dumps({"ok": False, "reason": "file_not_found"})); sys.exit(0)',
    'with open(_p, "rb") as _f: _raw = _f.read()',
    'try: _text = _raw.decode("utf-8")',
    'except UnicodeDecodeError:',
    '    print(json.dumps({"ok": False, "reason": "not_utf8"})); sys.exit(0)',
    '_n = _text.count(_old)',
    'if _n == 0:',
    '    print(json.dumps({"ok": False, "reason": "old_string_not_found"})); sys.exit(0)',
    'if _n > 1 and not _replace_all:',
    '    print(json.dumps({"ok": False, "reason": "old_string_not_unique", "occurrences": _n})); sys.exit(0)',
    '_out = _text.replace(_old, _new) if _replace_all else _text.replace(_old, _new, 1)',
    '_data = _out.encode("utf-8")',
    'with open(_p, "wb") as _f: _f.write(_data)',
    'print(json.dumps({"ok": True, "occurrences": _n if _replace_all else 1, "bytes_written": len(_data)}))',
  ].join('\n');
}

async function editFileTool(args, userCtx, responseCtx) {
  const rawPath = args && args.path;
  const oldStr = args && args.old_string;
  const newStr = args && args.new_string;
  const replaceAll = Boolean(args && args.replace_all);

  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { success: false, error: 'Missing required argument "path".' };
  }
  if (typeof oldStr !== 'string' || oldStr.length === 0) {
    return { success: false, error: 'old_string must be a non-empty string. Use write_file to create a new file.' };
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

  const currentProject = getCurrentProject(userCtx);
  if (!currentProject) {
    return { success: false, error: 'No project is currently selected. Run `gemix-project create` (new project) or `gemix-project switch <slug>` (existing) via bash first.' };
  }

  const auth = isPathAllowed(userCtx, rawPath, { op: 'write', currentProject });
  if (!auth.ok) {
    return { success: false, error: `edit_file refused: ${auth.reason}` };
  }

  const projectDir = getProjectRoot(userCtx, currentProject);
  const containerPath = _toContainerPath(auth.absPath, projectDir);

  const code = _buildPython(
    containerPath,
    Buffer.from(oldStr, 'utf-8').toString('base64'),
    Buffer.from(newStr, 'utf-8').toString('base64'),
    replaceAll,
  );

  const result = await runInProjectSandbox({
    userCtx,
    responseCtx,
    code,
    toolLabel: 'edit_file',
    timeoutMs: 15_000,
    crashPayload: { target_path: auth.absPath, replace_all: replaceAll },
    autoAttach: true,
  });

  if (result.error) return { success: false, error: result.error };

  const k = result.kernelResult;
  if (k.status !== 'ok') {
    return {
      success: false,
      error: k.error || 'edit_file failed inside sandbox.',
      stderr: k.stderr || '',
      traceback: k.traceback || null,
    };
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
    return { success: false, error: 'edit_file: could not parse sandbox report.', stdout: k.stdout || '' };
  }
  if (!report.ok) {
    const reasonMap = {
      file_not_found: 'File does not exist. Use write_file to create it first.',
      not_utf8: 'File is not UTF-8 — edit_file only supports text files.',
      old_string_not_found: 'old_string not found in the file.',
      old_string_not_unique: `old_string occurs ${report.occurrences} times — set replace_all=true or provide more surrounding context.`,
    };
    return {
      success: false,
      error: reasonMap[report.reason] || `edit_file failed: ${report.reason}`,
      occurrences: report.occurrences,
    };
  }

  const out = {
    success: true,
    path: `projects/${currentProject}/${path.relative(projectDir, auth.absPath).split(path.sep).join('/')}`,
    occurrences_replaced: report.occurrences,
    bytes_written: report.bytes_written,
    duration_ms: result.durationMs,
  };
  if (result.diff.modifiedFiles.length > 0) out.modified_files = result.diff.modifiedFiles;
  if (result.quotaWarning) out.quota_warning = result.quotaWarning;
  return out;
}

module.exports = { editFileTool };
