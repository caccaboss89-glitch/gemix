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
  getScratchDir,
  projectExists,
  userTotalBytes,
  userQuotaBytes,
} = require('../utils/userPaths');
const { getCurrentProject, saveLastCrash, clearLastCrash } = require('../utils/projectState');
const sandboxManager = require('./sandboxManager');
const { hasActiveBgTask } = require('../utils/bgTasks');
const { createLogger } = require('../utils/logger');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');

const log = createLogger('ProjectRun');

function _isKernelTransportFailure(err) {
  const msg = String(err && err.message || '');
  return msg.includes('Kernel not ready')
    || msg.includes('Kernel WS closed')
    || msg.includes('WS send failed')
    || msg.includes('socket hang up')
    || msg.includes('ECONNRESET')
    || msg.includes('ECONNREFUSED');
}

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
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
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
  let tRaw = Number(rawMs);
  let t = Number.isFinite(tRaw) ? Math.floor(tRaw) : CODE_EXEC_TIMEOUT_MS;
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
  requireProject = true,
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

  let projectName = await getCurrentProject(userCtx);
  const usingScratch = !projectName && !requireProject;
  
  if (requireProject && !projectName) {
    return {
      error: `No project is currently selected. Run \`gemix-project create\` (new task) or \`gemix-project switch <slug>\` (existing) via bash before ${toolLabel}.`,
    };
  }
  
  // Use scratch workspace for projectless execution (bash/code_execution without project)
  if (usingScratch) {
    projectName = '_scratch_';
    const scratchDir = getScratchDir(userCtx);
    if (scratchDir) {
      if (fs.existsSync(scratchDir)) {
        try {
          fs.rmSync(scratchDir, { recursive: true, force: true });
          log.info(`   🧹 Purged stale scratch directory: ${projectName}`);
        } catch (err) {
          log.warn(`   ⚠️ Failed to purge scratch directory: ${err.message}`);
        }
      }
      fs.mkdirSync(scratchDir, { recursive: true });
    }
  } else if (projectName && !projectExists(userCtx, projectName)) {
    return { error: `Current project "${projectName}" no longer exists on disk.` };
  }
  
  if (projectName && !usingScratch) {
    ensureProjectSkeleton(userCtx, projectName);
  }

  // ── Quota pre-check (per-user, aggregate of projects/ + searched_images/) ─
  const projectDir = usingScratch 
    ? getScratchDir(userCtx) 
    : getProjectRoot(userCtx, projectName);
  const quotaBytes = userQuotaBytes();
  const usedBefore = userTotalBytes(userCtx);
  if (usedBefore >= quotaBytes) {
    return {

    };
  }

  // ── Sandbox lifecycle ────────────────────────────────────────────────────
  let entry;
  try {
    entry = await sandboxManager.getOrCreate(userCtx, projectName);
  } catch (err) {
    log.error(`sandbox getOrCreate failed (${toolLabel}): ${err.message}`);
    await notifyAdmin(`Sandbox Manager (${toolLabel})`, `Failed to start sandbox for project "${projectName}": ${err.message}`);
    return { error: `Failed to start the Python sandbox: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }
  if (entry.busy) {
    return { error: `Another sandbox call is still running for this project. Try again in a moment.` };
  }
  
  const wasRestarted = !!entry.wasRestarted;
  if (wasRestarted) entry.wasRestarted = false; // consume it

  const effTimeoutMs = resolveTimeout(timeoutMs);

  // ── Snapshot, run, diff ──────────────────────────────────────────────────
  const before = snapshotProject(projectDir);
  const startedAt = Date.now();
  entry.busy = true;

  await saveLastCrash(userCtx, {
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
    if (_isKernelTransportFailure(err)) {
      try {
        await sandboxManager.shutdown(userCtx, projectName);
      } catch (shutdownErr) {
        log.warn(`failed to recycle stale sandbox (${toolLabel}): ${shutdownErr.message}`);
      }
    } else {
      await clearLastCrash(userCtx);
    }
    log.error(`kernel execute threw (${toolLabel}): ${err.message}`);
    await notifyAdmin(`Kernel Execute (${toolLabel})`, `Sandbox execution failed: ${err.message}`);
    return { error: `Sandbox execution failed: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }
  entry.busy = false;
  await clearLastCrash(userCtx);
  sandboxManager.touch(entry);

  const durationMs = Date.now() - startedAt;
  const after = snapshotProject(projectDir);

  // ── Diff ─────────────────────────────────────────────────────────────────
  const newFiles = [];
  const modifiedFiles = [];
  const outputDir = usingScratch 
    ? path.join(projectDir, 'output') 
    : getProjectSubdir(userCtx, projectName, 'output');
  let attachedTotalBytes = 0;
  let attachedCount = 0;

  // Resolve project root realpath once: every discovered file MUST resolve
  // inside it. Anything pointing outside (e.g. symlink to /readonly/searched_images)
  // is treated as an exfiltration attempt and refused for auto-attach.
  let projectRealRoot;
  try { projectRealRoot = fs.realpathSync(projectDir); }
  catch { projectRealRoot = projectDir; }

  for (const [absPath, info] of after) {
    const prev = before.get(absPath);
    const rel = path.relative(projectDir, absPath).split(path.sep).join('/');
    const item = { path: usingScratch ? `scratch/${rel}` : `/workspace/${rel}`, size: info.size };

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
      let attachSkippedReason = null;
      if (
        autoAttach && !usingScratch && isOutput &&
        attachedCount < CODE_EXEC_MAX_FILES_PER_CALL &&
        attachedTotalBytes + info.size <= CODE_EXEC_MAX_TOTAL_BYTES
      ) {
        // Validate media files before auto-attaching
        const ext = path.extname(absPath).toLowerCase();
        const isMedia = ['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a'].includes(ext);
        let isValid = true;
        if (isMedia) {
          try {
            const { execSync } = require('child_process');
            const ffprobeCmd = `ffprobe -v error -show_format -show_streams "${absPath}"`;
            execSync(ffprobeCmd, { stdio: 'pipe', timeout: 5000 });
          } catch (err) {
            const isMissingTool = err.code === 'ENOENT' || 
              String(err.message).includes('not recognized') || 
              String(err.message).includes('not found') ||
              err.status === 127;
              
            if (isMissingTool) {
              log.warn(`   ⚠️ ffprobe is not available on this host. Bypassing media integrity validation for ${rel}.`);
            } else {
              isValid = false;
              attachSkippedReason = `Invalid media file (corrupt or unreadable): ${err.message}`;
              log.warn(`   ⚠️ Skipping auto-attach of corrupt media: ${rel} - ${attachSkippedReason}`);
            }
          }
        }
        if (isValid) {
          responseCtx.attachments.push({
            name: path.basename(absPath),
            mimetype: _mimeForFile(absPath),
            filePath: absPath,
          });
          autoAttached = true;
          attachedCount++;
          attachedTotalBytes += info.size;
          log.info(`   📎 Auto-attached: ${rel} (${(info.size / 1048576).toFixed(2)} MB)`);
        }
      } else if (autoAttach && !usingScratch && isOutput) {
        if (attachedCount >= CODE_EXEC_MAX_FILES_PER_CALL) {
          attachSkippedReason = 'Max files per call reached (' + CODE_EXEC_MAX_FILES_PER_CALL + ')';
        } else if (attachedTotalBytes + info.size > CODE_EXEC_MAX_TOTAL_BYTES) {
          attachSkippedReason = 'Size limit reached (' + Math.floor((attachedTotalBytes + info.size) / 1048576) + ' MB > ' + Math.floor(CODE_EXEC_MAX_TOTAL_BYTES / 1048576) + ' MB)';
        }
      }
      item.auto_attached = autoAttached;
      if (attachSkippedReason) item.attach_skipped_reason = attachSkippedReason;
      newFiles.push(item);
    } else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      modifiedFiles.push(item);
    }
  }

  // ── Projectless write guard ──────────────────────────────────────────────
  if (usingScratch && (newFiles.length > 0 || modifiedFiles.length > 0)) {
    const first = [...newFiles, ...modifiedFiles][0].path;
    return {
      error: `Execution blocked: you attempted to create or modify files (e.g., "${first}") without an active project. For file-producing tasks, downloads, or scripts, you MUST create or switch to a project first via gemix-project. Use scratch mode only for calculations or stateless checks.`,
    };
  }

  // ── Quota post-check (per-user) ─────────────────────────────────────────
  let quotaWarning = null;
  const usedAfter = userTotalBytes(userCtx);
  if (usedAfter >= quotaBytes) {

  } else if (usedAfter >= quotaBytes * 0.9) {
    const pct = Math.round((usedAfter / quotaBytes) * 100);

  }

  return {
    kernelResult,
    diff: { newFiles, modifiedFiles },
    durationMs,
    projectName,
    projectDir,
    quotaWarning,
    sandboxRestarted: wasRestarted,
    bgTaskActive: !usingScratch && hasActiveBgTask(resolveStorageId(userCtx), projectName),
  };
}

module.exports = {
  runInProjectSandbox,
  snapshotProject,
  resolveTimeout,
};
