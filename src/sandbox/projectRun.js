// src/sandbox/projectRun.js
// Shared pipeline used by all agentic tools that need to run code inside the
// per-project sandbox (code_execution, write_file, edit_file, bash).
//
// Responsibilities:
//   1. Resolve + validate the user / current project (existence, quota).
//   2. Get-or-create the sandbox container for (user, project).
//   3. Persist a crash slot before executing so a killed bot leaves a
//      resumable trace; clear it on completion.
//   4. Snapshot the project tree before/after, diff, and (optionally)
//      auto-register files written under output/ as lazy attachments on
//      responseCtx.
//   5. Cap output size + project quota and surface warnings.
//
// The helper does NOT format the final tool message — callers (each tool)
// receive the raw result + diff and shape it as they please.

const fs = require('fs');
const path = require('path');

const {
  CODE_EXEC_TIMEOUT_MS,
  CODE_EXEC_MAX_TIMEOUT_MS,
  CODE_EXEC_MAX_FILES_PER_CALL,
  CODE_EXEC_MAX_TOTAL_BYTES,
  MAX_USER_TOTAL_MB,
  PLATFORM_DISCORD,
} = require('../config/constants');
const {
  resolveStorageId,
  ensureUserSkeleton,
  ensureProjectSkeleton,
  getProjectRoot,
  getProjectSubdir,
  projectExists,
  userTotalBytes,
  userQuotaBytes,
} = require('../utils/userPaths');
const { getCurrentProject, saveLastCrash, consumeLastCrash } = require('../utils/projectState');
const sandboxManager = require('./sandboxManager');
const { createLogger } = require('../utils/logger');

const log = createLogger('ProjectRun');

const FALLBACK_MIME_BY_EXT = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.xml': 'application/xml',
  '.py': 'text/x-python', '.js': 'application/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function _mimeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FALLBACK_MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Build a Map<absPath, {size, mtimeMs}> for every regular file under `dir`,
 * skipping dot-directories (.ipynb_checkpoints, .git, …).
 */
function snapshotProject(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          out.set(full, { size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* races */ }
      }
    }
  }
  return out;
}

/**
 * Resolve effective timeout in ms with the standard caps.
 */
function resolveTimeout(rawMs) {
  let t = Number.isFinite(rawMs) ? Math.floor(rawMs) : CODE_EXEC_TIMEOUT_MS;
  if (t <= 0) t = CODE_EXEC_TIMEOUT_MS;
  if (t > CODE_EXEC_MAX_TIMEOUT_MS) t = CODE_EXEC_MAX_TIMEOUT_MS;
  return t;
}

/**
 * Run a Python snippet in the user's current-project sandbox.
 *
 * @param {object} params
 * @param {object} params.userCtx
 * @param {object} params.responseCtx
 * @param {string} params.code             - Python code to execute
 * @param {string} params.toolLabel        - tool name for logs / crash slot
 * @param {number} [params.timeoutMs]
 * @param {object} [params.crashPayload]   - extra fields persisted in the crash slot
 * @param {boolean} [params.autoAttach=true] - auto-attach files in output/
 *
 * @returns {Promise<object>}
 *   On guard failure:    { error: string }
 *   On success:          { kernelResult, diff:{newFiles,modifiedFiles},
 *                          durationMs, projectName, projectDir, quotaWarning }
 */
async function runInProjectSandbox({
  userCtx,
  responseCtx,
  code,
  toolLabel = 'sandbox',
  timeoutMs,
  crashPayload = {},
  autoAttach = true,
}) {
  // ── Platform / project guards ────────────────────────────────────────────
  if (userCtx.platform === PLATFORM_DISCORD) {
    return { error: `${toolLabel} is only available on WhatsApp.` };
  }
  if (!resolveStorageId(userCtx)) {
    return { error: 'Could not resolve storage ID.' };
  }
  if (typeof code !== 'string' || code.length === 0) {
    return { error: 'Empty Python code.' };
  }

  ensureUserSkeleton(userCtx);

  const projectName = getCurrentProject(userCtx);
  if (!projectName) {
    return {
      error: `No project is currently selected. Run \`gemix-project create\` (new task) or \`gemix-project switch <slug>\` (existing) via bash before ${toolLabel}.`,
    };
  }
  if (!projectExists(userCtx, projectName)) {
    return { error: `Current project "${projectName}" no longer exists on disk.` };
  }
  ensureProjectSkeleton(userCtx, projectName);

  // ── Quota pre-check (per-user, aggregate of projects/ + searched_images/) ─
  const projectDir = getProjectRoot(userCtx, projectName);
  const quotaBytes = userQuotaBytes();
  const usedBefore = userTotalBytes(userCtx);
  if (usedBefore >= quotaBytes) {
    return {
      error: `Your personal cloud is full (${(usedBefore / 1048576).toFixed(0)} / ${MAX_USER_TOTAL_MB} MB used across all projects + searched_images). Free space via \`gemix-project cleanup\` (per-folder) or \`gemix-project delete --confirmed\` (whole project) via bash, and ask the user which artefacts to keep.`,
    };
  }

  // ── Sandbox lifecycle ────────────────────────────────────────────────────
  let entry;
  try {
    entry = await sandboxManager.getOrCreate(userCtx, projectName);
  } catch (err) {
    log.error(`sandbox getOrCreate failed (${toolLabel}): ${err.message}`);
    return { error: `Failed to start the Python sandbox: ${err.message}` };
  }
  if (entry.busy) {
    return { error: `Another sandbox call is still running for this project. Try again in a moment.` };
  }

  const effTimeoutMs = resolveTimeout(timeoutMs);

  // ── Snapshot, run, diff ──────────────────────────────────────────────────
  const before = snapshotProject(projectDir);
  const startedAt = Date.now();
  entry.busy = true;

  saveLastCrash(userCtx, {
    type: toolLabel,
    project: projectName,
    timeout_ms: effTimeoutMs,
    started_at: startedAt,
    ...crashPayload,
  });

  let kernelResult;
  try {
    kernelResult = await entry.kernel.execute(code, { timeoutMs: effTimeoutMs });
  } catch (err) {
    entry.busy = false;
    consumeLastCrash(userCtx, 0);
    log.error(`kernel execute threw (${toolLabel}): ${err.message}`);
    return { error: `Sandbox execution failed: ${err.message}` };
  }
  entry.busy = false;
  consumeLastCrash(userCtx, 0);
  sandboxManager.touch(entry);

  const durationMs = Date.now() - startedAt;
  const after = snapshotProject(projectDir);

  // ── Diff ─────────────────────────────────────────────────────────────────
  const newFiles = [];
  const modifiedFiles = [];
  const outputDir = getProjectSubdir(userCtx, projectName, 'output');
  let attachedTotalBytes = 0;
  let attachedCount = 0;

  // Resolve project root realpath once: every discovered file MUST resolve
  // inside it. Anything pointing outside (e.g. symlink to /readonly/permanent)
  // is treated as an exfiltration attempt and refused for auto-attach.
  let projectRealRoot;
  try { projectRealRoot = fs.realpathSync(projectDir); }
  catch { projectRealRoot = projectDir; }

  for (const [absPath, info] of after) {
    const prev = before.get(absPath);
    const rel = path.relative(projectDir, absPath).split(path.sep).join('/');
    const item = { path: `projects/${projectName}/${rel}`, size: info.size };

    // ── Symlink-escape guard ──
    let isEscaped = false;
    try {
      const real = fs.realpathSync(absPath);
      if (real !== absPath) {
        const relReal = path.relative(projectRealRoot, real);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) isEscaped = true;
      }
    } catch { /* file vanished mid-scan */ }

    if (isEscaped) {
      log.warn(`refusing symlink escape: ${rel} → outside project root`);
      item.escaped = true;
      item.auto_attached = false;
      if (!prev) newFiles.push(item);
      else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) modifiedFiles.push(item);
      continue;
    }

    if (!prev) {
      const isOutput = absPath === outputDir || absPath.startsWith(outputDir + path.sep);
      let autoAttached = false;
      if (
        autoAttach && isOutput &&
        attachedCount < CODE_EXEC_MAX_FILES_PER_CALL &&
        attachedTotalBytes + info.size <= CODE_EXEC_MAX_TOTAL_BYTES
      ) {
        responseCtx.attachments.push({
          name: path.basename(absPath),
          mimetype: _mimeForFile(absPath),
          filePath: absPath,
        });
        autoAttached = true;
        attachedCount++;
        attachedTotalBytes += info.size;
      }
      item.auto_attached = autoAttached;
      newFiles.push(item);
    } else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      modifiedFiles.push(item);
    }
  }

  // ── Quota post-check (per-user) ─────────────────────────────────────────
  let quotaWarning = null;
  const usedAfter = userTotalBytes(userCtx);
  if (usedAfter >= quotaBytes) {
    quotaWarning = `Personal cloud is now FULL (${(usedAfter / 1048576).toFixed(0)} / ${MAX_USER_TOTAL_MB} MB). Subsequent code_execution / write_file calls will fail until you run \`gemix-project cleanup\` or \`gemix-project delete --confirmed\` via bash.`;
  } else if (usedAfter >= quotaBytes * 0.9) {
    const pct = Math.round((usedAfter / quotaBytes) * 100);
    quotaWarning = `Personal cloud is ${pct}% full (${(usedAfter / 1048576).toFixed(0)} / ${MAX_USER_TOTAL_MB} MB). Consider \`gemix-project cleanup\` or \`gemix-project delete --confirmed\` via bash before more file-producing calls.`;
  }

  return {
    kernelResult,
    diff: { newFiles, modifiedFiles },
    durationMs,
    projectName,
    projectDir,
    quotaWarning,
  };
}

module.exports = {
  runInProjectSandbox,
  snapshotProject,
  resolveTimeout,
};
