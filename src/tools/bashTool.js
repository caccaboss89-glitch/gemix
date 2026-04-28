// src/tools/bashTool.js
// Run a shell command inside the project sandbox container. Backed by the
// same Jupyter kernel used by code_execution: the snippet shells out via
// subprocess.run() with cwd=/workspace and the same network/cap restrictions
// as the rest of the sandbox.
//
// The cwd is preserved across calls in the same kernel session through a
// global `_GEMIX_CWD` Python variable, so `cd subdir` followed by `pwd`
// behaves intuitively.

const crypto = require('crypto');
const path = require('path');
const { runInProjectSandbox } = require('../sandbox/projectRun');
const { logToolExecution } = require('../utils/executionLogger');
const { handleGemixProjectCmd, isGemixProjectCmd } = require('./gemixProjectCmds');
const { registerBgTask } = require('../utils/bgTasks');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CMD_LEN = 4_000;

function _buildPython(commandB64, timeoutSec) {
  const safeB64 = JSON.stringify(commandB64);
  // The command is executed exactly once. We append `; printf …PWD…` to the
  // user command via a wrapper so the resulting $PWD is captured at the end
  // and used to update the persistent _GEMIX_CWD across calls. Side effects
  // run only once.
  return [
    'import base64, json, os, subprocess',
    `_cmd = base64.b64decode(${safeB64}).decode("utf-8")`,
    'try:',
    '    _cwd = _GEMIX_CWD  # type: ignore[name-defined]',
    'except NameError:',
    '    _cwd = "/workspace"',
    'if not os.path.isdir(_cwd):',
    '    _cwd = "/workspace"',
    '_cwd = os.path.abspath(_cwd)',
    '_marker = "\\x1eGEMIX_PWD="',
    `_wrapped = "{ " + _cmd + "; }; __rc=$?; printf '%s%s\\x1e' \\"${'${__GEMIX_MARKER}'}\\" \\"$PWD\\"; exit \\"$__rc\\""`,
    '_env = dict(os.environ)',
    '_env["__GEMIX_MARKER"] = _marker',
    'try:',
    `    _r = subprocess.run(["/bin/bash", "-c", _wrapped], cwd=_cwd, env=_env, capture_output=True, text=True, timeout=${timeoutSec})`,
    '    _stdout_raw, _err, _rc = _r.stdout, _r.stderr, _r.returncode',
    'except subprocess.TimeoutExpired as _e:',
    '    _stdout_raw = (_e.stdout.decode("utf-8", "replace") if isinstance(getattr(_e, "stdout", None), (bytes, bytearray)) else (_e.stdout or ""))',
    '    _err = (_e.stderr.decode("utf-8", "replace") if isinstance(getattr(_e, "stderr", None), (bytes, bytearray)) else (_e.stderr or ""))',
    '    _rc = -124',
    '    _err = (_err + f"\\n[gemix] command timed out after {_e.timeout}s").lstrip()',
    '_out = _stdout_raw',
    '_idx = _stdout_raw.rfind(_marker)',
    'if _idx >= 0:',
    '    _tail = _stdout_raw[_idx + len(_marker):]',
    '    _pwd = _tail.split("\\x1e", 1)[0].strip()',
    '    _out = _stdout_raw[:_idx]',
    '    if _pwd and os.path.isdir(_pwd) and (_pwd == "/workspace" or _pwd.startswith("/workspace/")):',
    '        _GEMIX_CWD = _pwd  # noqa: F841',
    `print(json.dumps({"rc": _rc, "stdout": _out, "stderr": _err, "cwd": (globals().get("_GEMIX_CWD") or _cwd)}))`,
  ].join('\n');
}

function _buildBackgroundPython(commandB64, timeoutSec, outputPath, markerPath) {
  const safeB64 = JSON.stringify(commandB64);
  const safeOutput = JSON.stringify(outputPath);
  const safeMarker = JSON.stringify(markerPath);
  return [
    'import base64, json, os, subprocess, threading',
    `_cmd = base64.b64decode(${safeB64}).decode("utf-8")`,
    `_output = ${safeOutput}`,
    `_marker = ${safeMarker}`,
    `_timeout = ${timeoutSec}`,
    'try:',
    '    _cwd = _GEMIX_CWD  # type: ignore[name-defined]',
    'except NameError:',
    '    _cwd = "/workspace"',
    'if not os.path.isdir(_cwd):',
    '    _cwd = "/workspace"',
    'def _bg():',
    '    try:',
    '        _r = subprocess.run(["/bin/bash", "-c", _cmd], cwd=_cwd, capture_output=True, text=True, timeout=_timeout)',
    '        with open(_output, "w") as f:',
    '            if _r.stdout: f.write(_r.stdout)',
    '            if _r.stderr: f.write("\\n--- STDERR ---\\n" + _r.stderr)',
    '            f.write(f"\\n--- EXIT CODE: {_r.returncode} ---\\n")',
    '    except subprocess.TimeoutExpired as _e:',
    '        _s = ""',
    '        if hasattr(_e, "stdout") and _e.stdout:',
    '            _s = _e.stdout.decode("utf-8", "replace") if isinstance(_e.stdout, (bytes, bytearray)) else str(_e.stdout)',
    '        with open(_output, "w") as f:',
    '            f.write(_s + f"\\n--- TIMEOUT after {_e.timeout}s ---\\n")',
    '    except Exception as _ex:',
    '        with open(_output, "w") as f:',
    '            f.write(f"Error: {_ex}\\n")',
    '    finally:',
    '        try:',
    '            with open(_marker, "w") as f:',
    '                f.write("done")',
    '        except: pass',
    'os.makedirs(os.path.dirname(_output), exist_ok=True)',
    'threading.Thread(target=_bg, daemon=True).start()',
    'print(json.dumps({"bg": True}))',
  ].join('\n');
}

async function bashTool(args, userCtx, responseCtx) {
  const command = args && args.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { success: false, error: 'Missing required argument "command".' };
  }
  if (command.length > MAX_CMD_LEN) {
    return { success: false, error: `Command too long (${command.length} chars, max ${MAX_CMD_LEN}).` };
  }

  // ── Intercept gemix-project commands (no sandbox needed) ──────────────────
  if (isGemixProjectCmd(command)) {
    const result = await handleGemixProjectCmd(command, userCtx);
    logToolExecution({
      tool: 'bash/gemix-project',
      input: { command },
      output: result,
      meta: {
        user: {
          id: userCtx.userId || null,
          platform: userCtx.platform || null,
          chatId: userCtx.chatId || userCtx.groupId || userCtx.waJid || null,
        },
      },
    });
    return result;
  }

  const wantBackground = Boolean(args.background);
  const { getCurrentProject } = require('../utils/projectState');
  if (wantBackground && !(await getCurrentProject(userCtx))) {
    return { success: false, error: 'Background execution requires an active project. Run `gemix-project create` or `gemix-project switch <slug>` via bash first.' };
  }

  let tRaw = Number(args.timeout_ms);
  let timeoutMs = Number.isFinite(tRaw) ? Math.floor(tRaw) : DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
  // Subprocess timeout: leave a small buffer below the kernel timeout so we
  // can capture the timeout cleanly instead of letting the kernel kill us.
  const subprocessTimeoutSec = Math.max(2, Math.floor((timeoutMs - 1000) / 1000));

  // ── Background mode ──────────────────────────────────────────────────
  if (wantBackground) {
    const bgId = crypto.randomBytes(6).toString('hex');
    const outputRel = `temp/_bg_${bgId}.txt`;
    const doneRel = `temp/_bg_${bgId}.done`;

    const bgCode = _buildBackgroundPython(
      Buffer.from(command, 'utf-8').toString('base64'),
      subprocessTimeoutSec,
      `/workspace/${outputRel}`,
      `/workspace/${doneRel}`,
    );

    const bgResult = await runInProjectSandbox({
      userCtx,
      responseCtx,
      code: bgCode,
      toolLabel: 'bash_bg',
      timeoutMs: 10_000,
      crashPayload: { command_preview: command.slice(0, 300), background: true },
      autoAttach: false,
      requireProject: false,
    });

    if (bgResult.error) {
      logToolExecution({
        tool: 'bash_bg',
        input: { command, background: true },
        output: { success: false, error: bgResult.error },
        meta: { user: { id: userCtx.userId || null, platform: userCtx.platform || null } },
      });
      return { success: false, error: bgResult.error };
    }

    const k = bgResult.kernelResult;
    if (k.status !== 'ok') {
      return { success: false, error: k.error || 'Failed to start background command.' };
    }

    const absOutput = path.join(bgResult.projectDir, outputRel);
    const absDone = path.join(bgResult.projectDir, doneRel);
    registerBgTask(absOutput, absDone, timeoutMs);

    const out = {
      success: true,
      background: true,
      output_path: `projects/${bgResult.projectName}/${outputRel}`,
      message: 'Command started in background. Use read_file on output_path to get results (will wait automatically if still running).',
      duration_ms: bgResult.durationMs,
    };
    logToolExecution({
      tool: 'bash_bg',
      input: { command, timeout_ms: timeoutMs, background: true },
      output: out,
      meta: { project: bgResult.projectName, user: { id: userCtx.userId || null, platform: userCtx.platform || null } },
    });
    return out;
  }

  // ── Normal (blocking) mode ─────────────────────────────────────────────
  const code = _buildPython(
    Buffer.from(command, 'utf-8').toString('base64'),
    subprocessTimeoutSec,
  );

  const result = await runInProjectSandbox({
    userCtx,
    responseCtx,
    code,
    toolLabel: 'bash',
    timeoutMs,
    crashPayload: { command_preview: command.slice(0, 300) },
    autoAttach: true,
    requireProject: false,
  });

  if (result.error) {
    logToolExecution({
      tool: 'bash',
      input: { command, timeout_ms: timeoutMs },
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

  const k = result.kernelResult;
  if (k.status !== 'ok') {
    const errorOut = {
      success: false,
      error: k.error || 'bash failed inside sandbox.',
      stderr: k.stderr || '',
      traceback: k.traceback || null,
    };
    logToolExecution({
      tool: 'bash',
      input: { command, timeout_ms: timeoutMs },
      output: errorOut,
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
    return errorOut;
  }

  // Last JSON line carries rc/stdout/stderr/cwd; everything before is noise.
  const lines = (k.stdout || '').trim().split(/\r?\n/);
  let report = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try { report = JSON.parse(ln); break; } catch { /* */ }
  }
  if (!report) {
    const parseError = { success: false, error: 'bash: could not parse sandbox report.', stdout: k.stdout || '' };
    logToolExecution({
      tool: 'bash',
      input: { command, timeout_ms: timeoutMs },
      output: parseError,
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
    return parseError;
  }

  const out = {
    success: report.rc === 0,
    rc: report.rc,
    stdout: report.stdout || '',
    stderr: report.stderr || '',
    cwd: report.cwd || '/workspace',
    duration_ms: result.durationMs,
  };
  if (result.diff.newFiles.length > 0) out.new_files = result.diff.newFiles;
  if (result.diff.modifiedFiles.length > 0) out.modified_files = result.diff.modifiedFiles;
  if (result.quotaWarning) out.quota_warning = result.quotaWarning;

  // Post-execution write violation check: bash can bypass Python's open() guard
  // so we verify here that nothing was written outside the authorized dirs.
  const _BASH_ALLOWED = ['temp/', 'output/', 'code/'];
  const _projectPrefix = `projects/${result.projectName}/`;
  const _allDiff = [
    ...(result.diff.newFiles || []),
    ...(result.diff.modifiedFiles || []),
  ];
  const _violations = _allDiff.filter(f => {
    if (f.escaped) return false;
    const rel = (f.path || '').startsWith(_projectPrefix) ? f.path.slice(_projectPrefix.length) : null;
    return rel !== null && !_BASH_ALLOWED.some(p => rel.startsWith(p));
  });
  if (_violations.length > 0) {
    out.write_violations = _violations.map(f => f.path);
    out.message_for_ai = `Write violation: ${_violations.length} file(s) created/modified outside authorized dirs (temp/, output/, code/): ${_violations.map(f => f.path).join(', ')}. Only write to those subdirectories.`;
  }

  logToolExecution({
    tool: 'bash',
    input: { command, timeout_ms: timeoutMs },
    output: out,
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
  return out;
}

module.exports = { bashTool };
