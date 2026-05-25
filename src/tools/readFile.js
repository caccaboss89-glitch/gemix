// src/tools/readFile.js
//
// read_file is the AI-facing tool that lets the assistant pull a specific
// file from chat history (or, in agentic mode, from the project workspace
// and a few read-only zones) into the conversation.
//
// Two return shapes:
//   1. Text-based files → wrapped in <FileContent> with line numbers and
//      truncated past MAX_TEXT_BYTES.
//   2. Media (PDF, audio, video, image) → exposed via the public attachment
//      tunnel as `{type:'input_file', file_url:'https://…'}` so xAI's
//      Responses endpoint fetches and pre-processes them natively (OCR,
//      STT, frame extraction). For images we keep the legacy base64
//      `image_url` part since it is already accepted natively as
//      `input_image` by /v1/responses (no need to round-trip through the
//      tunnel for those).
//
// Output paths are unchanged from the AI's perspective — only the
// transport for non-image binaries switched from in-line base64 + custom
// pre-pass to public URL + xAI native ingestion.

const fs = require('fs');
const path = require('path');
const { mediaToContentPart } = require('../utils/media');
const { isPathAllowed, ensureUserSkeleton, resolveStorageId } = require('../utils/userPaths');
const { getBgTask, removeBgTask } = require('../utils/bgTasks');
const { isSandboxAlive } = require('../sandbox/sandboxManager');
const { getCurrentProject } = require('../utils/projectState');
const { getPublicAttachmentUrl } = require('../utils/tempFileServer');
const { createLogger } = require('../utils/logger');

const log = createLogger('ReadFileTool');

const NON_READABLE_EXTS = new Set([
  '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx',
  '.exe', '.dll', '.bin', '.so', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.jar', '.class', '.pyc', '.db', '.sqlite', '.iso', '.dmg',
]);

const MAX_TEXT_BYTES = 50 * 1024; // 50KB cap for inline text reads
const MAX_BG_AUTO_ATTACH = 20;
const MAX_BG_AUTO_ATTACH_BYTES = 100 * 1024 * 1024;

const _BG_MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
};
function _mimeForBg(absPath) {
  return _BG_MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
}

const MAX_IMAGE_READS = 10;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.m4a', '.flac', '.aac'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const AUDIO_MIME = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac' };
const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function _collectRecentProjectWriteViolations(projectDir, startedAt) {
  const violations = [];
  const stack = [projectDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.mtimeMs < startedAt) continue;
      const rel = path.relative(projectDir, abs).split(path.sep).join('/');
      if (!rel.startsWith('temp/') && !rel.startsWith('output/') && !rel.startsWith('code/')) {
        violations.push(`/workspace/${rel}`);
      }
    }
  }
  return violations;
}

/**
 * Build an `input_file` content part backed by the public attachment tunnel.
 * `kind` selects the TTL (`history` = 24h, `temp` = 1h).
 *
 * Returns `[textTag, inputFilePart]`. Errors propagate as { success:false }
 * tool results so the AI can react.
 */
function _buildInputFilePart(absPath, displayPath, originalName, mimetype, kind) {
  let urlInfo;
  try {
    urlInfo = getPublicAttachmentUrl(absPath, originalName, { kind, mimetype });
  } catch (err) {
    log.warn(`Failed to expose ${displayPath} via tunnel: ${err.message}`);
    return { success: false, error: `Cannot expose "${displayPath}" via attachment tunnel: ${err.message}` };
  }
  return [
    { type: 'text', text: `[Attachment: ${displayPath}]` },
    { type: 'input_file', file_url: urlInfo.url },
  ];
}

/**
 * Read file tool execution logic.
 *
 * Path resolution (unchanged):
 *  - Discord and non-agentic: any non-absolute path is treated as relative
 *    to chat history.
 *  - Agentic: absolute /workspace and /readonly paths are honoured. A bare
 *    filename (no slash) still routes to history for convenience.
 *  - `skills:<name>.md` reads from src/data/skills/.
 */
async function readFileTool(filePath, userCtx, responseCtx) {
  if (responseCtx.imagesReadCount === undefined) responseCtx.imagesReadCount = 0;
  let bgWriteViolationWarning = '';

  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }

  ensureUserSkeleton(userCtx);

  const agenticUnlocked = userCtx.agenticUnlocked;
  let rawPath = (filePath || '').trim();

  if (!rawPath.startsWith('/') && !rawPath.startsWith('skills:')) {
    if (rawPath.startsWith('./')) {
      rawPath = rawPath.slice(2);
    }
    const isBareFilename = !rawPath.includes('/');
    if (!agenticUnlocked || isBareFilename) {
      if (!rawPath.startsWith('history/')) {
        rawPath = 'history/' + rawPath;
      }
    }
  }

  const currentProject = await getCurrentProject(userCtx);
  const check = isPathAllowed(userCtx, rawPath, { op: 'read', currentProject, agenticUnlocked });
  if (!check.ok) {
    return { success: false, error: `Access denied: ${check.reason}` };
  }

  const absolutePath = check.absPath;
  const displayPath = rawPath;

  if (!fs.existsSync(absolutePath)) {
    const bgTask = getBgTask(absolutePath);
    if (bgTask) {
      // Wait for background task to finish
      const maxWaitMs = Math.min(bgTask.timeoutMs + 10_000, 130_000);
      const elapsed = Date.now() - bgTask.startedAt;
      const remaining = Math.max(0, maxWaitMs - elapsed);
      const projectDir = path.dirname(path.dirname(absolutePath));
      const projectName = path.basename(projectDir);
      const pollMs = 1500;
      let waited = 0;
      let deadCount = 0;

      while (waited < remaining) {
        if (fs.existsSync(bgTask.doneMarkerPath)) break;
        if (!isSandboxAlive(userCtx, projectName)) {
          deadCount++;
          if (deadCount > 10) {
            removeBgTask(absolutePath);
            return { success: false, error: `Background command failed: the sandbox container for project "${projectName}" was lost or restarted. The background task was terminated.` };
          }
        } else {
          deadCount = 0;
        }
        await new Promise(r => setTimeout(r, pollMs));
        waited += pollMs;
      }
      const bgStartedAt = bgTask.startedAt;
      removeBgTask(absolutePath);
      if (fs.existsSync(bgTask.doneMarkerPath) && !fs.existsSync(absolutePath)) {
        try { fs.writeFileSync(absolutePath, '', 'utf-8'); } catch { }
      }
      try { if (fs.existsSync(bgTask.doneMarkerPath)) fs.unlinkSync(bgTask.doneMarkerPath); } catch { }
      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: 'Background command timed out. Output file was not created.' };
      }
      try {
        const violations = _collectRecentProjectWriteViolations(projectDir, bgStartedAt);
        if (violations.length > 0) {
          bgWriteViolationWarning = `\n\n[Background write violation: ${violations.length} file(s) changed outside authorized dirs temp/, output/, code/: ${violations.join(', ')}]`;
        }
      } catch { }
      // Auto-attach background output files (unchanged from previous behaviour).
      if (responseCtx && Array.isArray(responseCtx.attachments)) {
        const outputDir = path.join(projectDir, 'output');

        let projectRealRoot;
        try { projectRealRoot = fs.realpathSync(projectDir); } catch { projectRealRoot = projectDir; }

        let bgAttachedBytes = 0;
        const stack = [outputDir];

        while (stack.length > 0) {
          if (responseCtx.attachments.length >= MAX_BG_AUTO_ATTACH || bgAttachedBytes >= MAX_BG_AUTO_ATTACH_BYTES) break;
          const cur = stack.pop();
          let entries = [];
          try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }

          for (const e of entries) {
            const absFile = path.join(cur, e.name);

            if (e.isDirectory()) {
              stack.push(absFile);
              continue;
            }
            if (!e.isFile()) continue;

            if (responseCtx.attachments.length >= MAX_BG_AUTO_ATTACH || bgAttachedBytes >= MAX_BG_AUTO_ATTACH_BYTES) break;

            try {
              const st = fs.statSync(absFile);
              if (st.mtimeMs < bgStartedAt || st.size === 0) continue;
              if (bgAttachedBytes + st.size > MAX_BG_AUTO_ATTACH_BYTES) continue;

              const already = responseCtx.attachments.some(a => a.filePath && path.resolve(a.filePath) === path.resolve(absFile));
              if (!already) {
                let isEscaped = false;
                try {
                  const real = fs.realpathSync(absFile);
                  if (real !== absFile) {
                    const relReal = path.relative(projectRealRoot, real);
                    if (relReal.startsWith('..') || path.isAbsolute(relReal)) isEscaped = true;
                  }
                } catch { continue; }

                if (isEscaped) continue;

                responseCtx.attachments.push({ name: e.name, mimetype: _mimeForBg(absFile), filePath: absFile });
                bgAttachedBytes += st.size;
              }
            } catch { /* skip */ }
          }
        }
      }
      // Fall through to normal file reading
    } else {
      return { success: false, error: `File not found at path "${displayPath}".` };
    }
  }

  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (err) {
    if (err.code === 'EACCES') {
      return { success: false, error: `Access denied to file "${displayPath}".` };
    }
    return { success: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }

  if (stat.isDirectory()) {
    return { success: false, error: `Path is a directory, not a file.` };
  }

  // Touch atime/mtime so the history pruner sees this file as recently used.
  const now = new Date();
  try { fs.utimesSync(absolutePath, now, now); } catch { /* ignore */ }

  const ext = path.extname(absolutePath).toLowerCase();
  const sanitizedPath = displayPath;
  const fileSize = stat.size;
  const originalName = path.basename(absolutePath);
  // History reads keep their longer TTL; everything else (project files,
  // skills) is exposed for 1h since the conversation rarely needs more.
  const tunnelKind = rawPath.startsWith('history/') ? 'history' : 'temp';

  if (NON_READABLE_EXTS.has(ext)) {
    return { success: false, error: `read_file: files with extension "${ext}" are binary and not supported for direct reading. Use specialized tools or scripts to analyze them.` };
  }

  // ── Images ─────────────────────────────────────────────────────────────
  // Stay base64 inline. /v1/responses accepts image data URLs natively as
  // input_image; round-tripping through the tunnel would only add latency.
  if (IMAGE_EXTS.includes(ext)) {
    if (responseCtx.imagesReadCount >= MAX_IMAGE_READS) {
      return { success: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` };
    }
    if (fileSize === 0) {
      return { success: false, error: `Image file "${displayPath}" is empty.` };
    }
    responseCtx.imagesReadCount++;
    const buffer = fs.readFileSync(absolutePath);
    return [
      { type: 'text', text: `[Attachment: ${sanitizedPath}]` },
      mediaToContentPart(buffer, IMAGE_MIME[ext]),
    ];
  }

  // ── PDF / audio / video ───────────────────────────────────────────────
  // Hand off to the public tunnel and emit an input_file part. xAI fetches
  // the URL itself, runs OCR / STT / frame extraction, and folds the result
  // into the prompt at /v1/responses without any further work on our side.
  if (ext === '.pdf') {
    if (fileSize > 48 * 1024 * 1024) {
      return { success: false, error: `PDF "${displayPath}" exceeds the 48 MB xAI limit.` };
    }
    return _buildInputFilePart(absolutePath, displayPath, originalName, 'application/pdf', tunnelKind);
  }

  if (AUDIO_EXTS.includes(ext)) {
    if (fileSize > MAX_AUDIO_BYTES) {
      const maxMins = Math.round(MAX_AUDIO_BYTES / (16 * 1024 * 60));
      return { success: false, error: `Audio file exceeds size limit (max ~${maxMins} minutes).` };
    }
    return _buildInputFilePart(absolutePath, displayPath, originalName, AUDIO_MIME[ext], tunnelKind);
  }

  if (VIDEO_EXTS.includes(ext)) {
    if (fileSize > MAX_VIDEO_BYTES) {
      return { success: false, error: `Video file exceeds size limit (${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB max). GemiX does not support video editing.` };
    }
    return _buildInputFilePart(absolutePath, displayPath, originalName, VIDEO_MIME[ext], tunnelKind);
  }

  // ── Text / Code / unknown small file ──────────────────────────────────
  // Read inline up to MAX_TEXT_BYTES. Larger files are truncated.
  if (fileSize > MAX_TEXT_BYTES * 4) {
    return { success: false, error: `File is too large to read as text (max ${MAX_TEXT_BYTES / 1024}KB).` };
  }

  const buffer = fs.readFileSync(absolutePath);
  let text = buffer.toString('utf-8');
  const isTruncated = Buffer.byteLength(text) > MAX_TEXT_BYTES;
  if (isTruncated) {
    text = Buffer.from(buffer).slice(0, MAX_TEXT_BYTES).toString('utf-8') + '\n\n... (file truncated)';
  }

  const lines = text.split(/\r?\n/);
  const numberedText = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

  const output = `<FileContent path="${sanitizedPath}" size="${fileSize}"${isTruncated ? ' truncated="true"' : ''}>
${numberedText}
</FileContent>${bgWriteViolationWarning}`;

  return { success: true, message: output };
}

module.exports = { readFileTool };
