// src/tools/codeExecution.js
// Stateful Python execution tool, scoped to the current project. Files written
// to projects/<slug>/output/ are auto-buffered as attachments so the AI can
// deliver them via send_whatsapp_message / send_email afterwards.

const fs = require('fs');
const path = require('path');

const {
  CODE_EXEC_TIMEOUT_MS,
  CODE_EXEC_MAX_TIMEOUT_MS,
  CODE_EXEC_MAX_FILES_PER_CALL,
  CODE_EXEC_MAX_TOTAL_BYTES,
  MAX_PROJECT_SIZE_MB,
  PLATFORM_DISCORD,
} = require('../config/constants');
const {
  resolveStorageId,
  ensureUserSkeleton,
  ensureProjectSkeleton,
  getProjectRoot,
  getProjectSubdir,
  projectExists,
  projectSizeBytes,
} = require('../utils/userPaths');
const { getCurrentProject, saveLastCrash, consumeLastCrash } = require('../utils/projectState');
const sandboxManager = require('../sandbox/sandboxManager');
const { createLogger } = require('../utils/logger');

const log = createLogger('CodeExecution');

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
 * Snapshot file mtime+size for every file under `dir` (recursive, excluding
 * dot-directories like .ipynb_checkpoints).
 * Used to compute the diff after code execution.
 *
 * @param {string} dir
 * @returns {Map<string, {size:number, mtimeMs:number}>}
 */
function _snapshot(dir) {
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
        } catch { /* skip races */ }
      }
    }
  }
  return out;
}

/**
 * Format the kernel result into a string-y payload that fits inside one
 * tool message.
 */
function _formatResult({ kernelResult, newFiles, modifiedFiles, quotaWarning, durationMs }) {
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

  if (newFiles.length > 0) out.new_files = newFiles;
  if (modifiedFiles.length > 0) out.modified_files = modifiedFiles;
  if (quotaWarning) out.quota_warning = quotaWarning;
  return out;
}

/**
 * Code execution tool entry-point.
 *
 * @param {object} args { code, timeout_ms? }
 * @param {object} userCtx
 * @param {object} responseCtx — attachment buffer, etc.
 */
async function codeExecutionTool(args, userCtx, responseCtx) {
  // ── Platform / project guards ────────────────────────────────────────────
  if (userCtx.platform === PLATFORM_DISCORD) {
    return { success: false, error: 'code_execution is only available on WhatsApp.' };
  }
  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID.' };
  }
  const code = args && args.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return { success: false, error: 'Missing required argument "code".' };
  }

  ensureUserSkeleton(userCtx);

  const projectName = getCurrentProject(userCtx);
  if (!projectName) {
    return {
      success: false,
      error: 'No project is currently selected. Call create_project (for a new task) or switch_project before code_execution.',
    };
  }
  if (!projectExists(userCtx, projectName)) {
    return { success: false, error: `Current project "${projectName}" no longer exists on disk.` };
  }
  ensureProjectSkeleton(userCtx, projectName);

  // ── Quota pre-check ──────────────────────────────────────────────────────
  const projectDir = getProjectRoot(userCtx, projectName);
  const quotaBytes = MAX_PROJECT_SIZE_MB * 1024 * 1024;
  const usedBefore = projectSizeBytes(userCtx, projectName);
  if (usedBefore >= quotaBytes) {
    return {
      success: false,
      error: `Project "${projectName}" is already at or over the size quota (${MAX_PROJECT_SIZE_MB} MB). Run cleanup_project before generating new files.`,
    };
  }

  // ── Sandbox lifecycle ────────────────────────────────────────────────────
  let entry;
  try {
    entry = await sandboxManager.getOrCreate(userCtx, projectName);
  } catch (err) {
    log.error(`sandbox getOrCreate failed: ${err.message}`);
    return {
      success: false,
      error: `Failed to start the Python sandbox: ${err.message}`,
    };
  }
  if (entry.busy) {
    return { success: false, error: 'Another code_execution call is still running for this project. Try again in a moment.' };
  }

  // ── Resolve effective timeout ────────────────────────────────────────────
  let timeoutMs = Number.isFinite(args.timeout_ms) ? Math.floor(args.timeout_ms) : CODE_EXEC_TIMEOUT_MS;
  if (timeoutMs <= 0) timeoutMs = CODE_EXEC_TIMEOUT_MS;
  if (timeoutMs > CODE_EXEC_MAX_TIMEOUT_MS) timeoutMs = CODE_EXEC_MAX_TIMEOUT_MS;

  // ── Snapshot, run, diff ──────────────────────────────────────────────────
  const before = _snapshot(projectDir);
  const startedAt = Date.now();
  entry.busy = true;

  // Crash recovery slot: persist the fact that we are about to run code.
  // If the bot dies mid-execution this slot survives and is picked up by
  // handler.js on the next message so the AI can resume gracefully.
  saveLastCrash(userCtx, {
    type: 'code_execution',
    project: projectName,
    code_preview: String(code).slice(0, 400),
    timeout_ms: timeoutMs,
    started_at: startedAt,
  });

  let kernelResult;
  try {
    kernelResult = await entry.kernel.execute(code, { timeoutMs });
  } catch (err) {
    entry.busy = false;
    consumeLastCrash(userCtx, 0); // clear slot — error is reported synchronously
    log.error(`kernel execute threw: ${err.message}`);
    return { success: false, error: `Sandbox execution failed: ${err.message}` };
  }
  entry.busy = false;
  // Execution completed (ok or python-level error): clear the crash slot,
  // the result is already returned synchronously to the AI.
  consumeLastCrash(userCtx, 0);
  sandboxManager.touch(entry);

  const durationMs = Date.now() - startedAt;
  const after = _snapshot(projectDir);

  const newFiles = [];
  const modifiedFiles = [];
  const outputDir = getProjectSubdir(userCtx, projectName, 'output');
  let attachedTotalBytes = 0;
  let attachedCount = 0;

  for (const [absPath, info] of after) {
    const prev = before.get(absPath);
    const rel = path.relative(projectDir, absPath).split(path.sep).join('/');
    const item = { path: `projects/${projectName}/${rel}`, size: info.size };

    if (!prev) {
      // Only auto-attach files inside output/. Files under code/, temp/,
      // figures/ are intermediate by convention — the AI can still mention
      // them or call read_file to inspect them.
      const isOutput = absPath.startsWith(outputDir + path.sep) || absPath === outputDir;
      let autoAttached = false;
      if (
        isOutput &&
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

  // ── Quota post-check ─────────────────────────────────────────────────────
  let quotaWarning = null;
  const usedAfter = projectSizeBytes(userCtx, projectName);
  if (usedAfter >= quotaBytes * 0.9) {
    const pct = Math.round((usedAfter / quotaBytes) * 100);
    quotaWarning = `Project storage is ${pct}% full (${(usedAfter / 1048576).toFixed(1)} / ${MAX_PROJECT_SIZE_MB} MB). Consider cleanup_project before more file-producing calls.`;
  }

  return _formatResult({ kernelResult, newFiles, modifiedFiles, quotaWarning, durationMs });
}

module.exports = { codeExecutionTool };
