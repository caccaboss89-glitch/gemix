// src/tools/writeFile.js
// Agentic file-write tool. Writes are routed through the project sandbox
// (Python kernel) so the file is created as the sandbox uid (1000) and the
// kernel sees it immediately for any subsequent code_execution call.
//
// The path MUST be relative to the user root and resolve inside the
// CURRENT project's temp/ output/ or code/ subfolder. All other
// destinations (history/, permanent/, project root, projects root, user
// root, skills/) are rejected by isPathAllowed.

const path = require('path');
const { runInProjectSandbox } = require('../sandbox/projectRun');
const { isPathAllowed, getProjectRoot } = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');
const { logToolExecution } = require('../utils/executionLogger');

const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap

/**
 * Build the Python snippet that materialises the write inside the sandbox.
 * Content is shipped as base64 to safely carry binary or non-UTF-8 bytes.
 */
function _buildPython(absPathInsideContainer, contentB64, mode) {
  // Encode the path as a Python repr to defeat any quoting issue.
  const safePath = JSON.stringify(absPathInsideContainer);
  const safeB64 = JSON.stringify(contentB64);
  return [
    'import os, base64',
    `_p = ${safePath}`,
    `_data = base64.b64decode(${safeB64})`,
    `os.makedirs(os.path.dirname(_p), exist_ok=True)`,
    mode === 'append'
      ? `with open(_p, "ab") as _f: _f.write(_data)`
      : `with open(_p, "wb") as _f: _f.write(_data)`,
    `print(f"wrote {_p} ({len(_data)} bytes)")`,
  ].join('\n');
}

/**
 * Translate a host absolute project path (data/users/<id>/projects/<name>/code/x.py)
 * into the path as seen inside the sandbox container (/workspace/code/x.py).
 */
function _toContainerPath(absHostPath, projectName, projectDir) {
  // sandbox bind: <projectDir> -> /workspace
  const rel = path.relative(projectDir, absHostPath).split(path.sep).join('/');
  return `/workspace/${rel}`;
}

/**
 * write_file tool entry-point.
 * @param {object} args { path, content, encoding?, mode? }
 *   - path:     relative path under projects/<current>/{temp|output|code}/
 *   - content:  string (utf-8) or base64 if encoding='base64'
 *   - encoding: 'utf-8' (default) | 'base64'
 *   - mode:     'overwrite' (default) | 'append'
 */
async function writeFileTool(args, userCtx, responseCtx) {
  const rawPath = args && args.path;
  const content = args && args.content;
  const encoding = (args && args.encoding) || 'utf-8';
  const mode = (args && args.mode) || 'overwrite';

  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { success: false, error: 'Missing required argument "path".' };
  }
  if (typeof content !== 'string') {
    return { success: false, error: 'Missing required argument "content" (string).' };
  }
  if (encoding !== 'utf-8' && encoding !== 'base64') {
    return { success: false, error: 'Unsupported encoding. Use "utf-8" or "base64".' };
  }
  if (mode !== 'overwrite' && mode !== 'append') {
    return { success: false, error: 'Unsupported mode. Use "overwrite" or "append".' };
  }

  const currentProject = await getCurrentProject(userCtx);
  if (!currentProject) {
    return { success: false, error: 'No project is currently selected. Run `gemix-project create` (new project) or `gemix-project switch <slug>` (existing) via bash first.' };
  }

  // Path authorization (centralised — same rules as every other write tool).
  const auth = isPathAllowed(userCtx, rawPath, { op: 'write', currentProject });
  if (!auth.ok) {
    return { success: false, error: `write_file refused: ${auth.reason}` };
  }

  // Encode content as base64 once (binary-safe transport into Python).
  let buf;
  try {
    buf = encoding === 'base64'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf-8');
  } catch (e) {
    return { success: false, error: `Cannot decode content: ${e.message}` };
  }
  if (buf.length > MAX_WRITE_BYTES) {
    return { success: false, error: `Content too large (${buf.length} bytes). Max ${MAX_WRITE_BYTES} bytes per write_file call.` };
  }

  // auth.absPath is host-side absolute. The sandbox sees the project dir as /workspace.
  const projectDir = getProjectRoot(userCtx, currentProject);
  const containerPath = _toContainerPath(auth.absPath, currentProject, projectDir);

  const code = _buildPython(containerPath, buf.toString('base64'), mode);

  const result = await runInProjectSandbox({
    userCtx,
    responseCtx,
    code,
    toolLabel: 'write_file',
    timeoutMs: 15_000,
    crashPayload: { target_path: auth.absPath, mode, bytes: buf.length },
    autoAttach: true,
    requireProject: true,
  });

  if (result.error) {
    const errorOut = { success: false, error: result.error };
    logToolExecution({
      tool: 'write_file',
      input: { path: rawPath, encoding, mode, bytes: buf.length },
      output: errorOut,
      meta: { user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }

  const k = result.kernelResult;
  if (k.status !== 'ok') {
    const errorOut = {
      success: false,
      error: k.error || 'write_file failed inside sandbox.',
      stderr: k.stderr || '',
      traceback: k.traceback || null,
    };
    logToolExecution({
      tool: 'write_file',
      input: { path: rawPath, encoding, mode, bytes: buf.length },
      output: errorOut,
      meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
    });
    return errorOut;
  }

  const out = {
    success: true,
    path: auth.absPath ? `projects/${currentProject}/${path.relative(projectDir, auth.absPath).split(path.sep).join('/')}` : rawPath,
    bytes_written: buf.length,
    mode,
    encoding,
    duration_ms: result.durationMs,
  };
  if (result.diff.newFiles.length > 0) out.new_files = result.diff.newFiles;
  if (result.diff.modifiedFiles.length > 0) out.modified_files = result.diff.modifiedFiles;
  if (result.quotaWarning) out.quota_warning = result.quotaWarning;
  logToolExecution({
    tool: 'write_file',
    input: { path: rawPath, encoding, mode, bytes: buf.length },
    output: out,
    meta: { project: result.projectName, duration_ms: result.durationMs, user: { id: userCtx.userId || null, platform: userCtx.platform || null, chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null } },
  });
  return out;
}

module.exports = { writeFileTool };
