// src/tools/readFile.js
const fs = require('fs');
const path = require('path');
const { PLATFORM_DISCORD } = require('../config/constants');
const { extractTextFromPdfBuffer, mediaToContentPart } = require('../utils/media');
const { isPathAllowed, ensureUserSkeleton, resolveStorageId } = require('../utils/userPaths');
const { getBgTask, removeBgTask } = require('../utils/bgTasks');
const { isSandboxAlive } = require('../sandbox/sandboxManager');

const MAX_TEXT_BYTES = 50 * 1024; // 50KB limit for text reading
const MAX_BG_AUTO_ATTACH = 20;        // max files to auto-attach from a completed background task
const MAX_BG_AUTO_ATTACH_BYTES = 100 * 1024 * 1024; // 100 MB total cap

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
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15MB limit for audio
const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // 60MB limit for video (caller still enforces 15s duration cap)

const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.m4a'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];

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
        violations.push(`projects/${path.basename(projectDir)}/${rel}`);
      }
    }
  }
  return violations;
}

/**
 * Read file tool execution logic.
 * On Discord, paths are implicitly relative to history/. On WhatsApp paths
 * are relative to the user root and may target history/, permanent/,
 * searched_images/, projects/**, or the special skills: prefix.
 */
async function readFileTool(filePath, userCtx, responseCtx) {
  if (responseCtx.imagesReadCount === undefined) responseCtx.imagesReadCount = 0;
  let bgWriteViolationWarning = '';

  if (!resolveStorageId(userCtx)) {
    return JSON.stringify({ success: false, error: 'Could not resolve storage ID for this context.' });
  }

  ensureUserSkeleton(userCtx);

  const isDiscord = userCtx.platform === PLATFORM_DISCORD;

  // On Discord, allow both "file.pdf" and "history/file.pdf" by normalizing.
  let rawPath = (filePath || '').trim();
  if (isDiscord) {
    if (rawPath.startsWith('./')) rawPath = rawPath.slice(2);
    if (rawPath.startsWith('/')) rawPath = rawPath.replace(/^\/+/, '');
    if (!rawPath.startsWith('history/') && !rawPath.startsWith('skills:') && !rawPath.startsWith('skills/')) {
      rawPath = 'history/' + rawPath;
    }
  }

  const check = isPathAllowed(userCtx, rawPath, { op: 'read' });
  if (!check.ok) {
    return JSON.stringify({ success: false, error: `Access denied: ${check.reason}` });
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

      while (waited < remaining) {
        if (fs.existsSync(bgTask.doneMarkerPath)) break;
        // Watchdog: if the sandbox for this project is gone, the bg task definitely crashed.
        if (!isSandboxAlive(userCtx, projectName)) {
           return JSON.stringify({ success: false, error: 'Background command failed: the sandbox container or kernel was lost.' });
        }
        await new Promise(r => setTimeout(r, pollMs));
        waited += pollMs;
      }
      const bgStartedAt = bgTask.startedAt;
      removeBgTask(absolutePath);
      // Process finished but no output file → create empty
      if (fs.existsSync(bgTask.doneMarkerPath) && !fs.existsSync(absolutePath)) {
        try { fs.writeFileSync(absolutePath, '', 'utf-8'); } catch { }
      }
      try { if (fs.existsSync(bgTask.doneMarkerPath)) fs.unlinkSync(bgTask.doneMarkerPath); } catch { }
      if (!fs.existsSync(absolutePath)) {
        return JSON.stringify({ success: false, error: 'Background command timed out. Output file was not created.' });
      }
      try {
        const projectDir = path.dirname(path.dirname(absolutePath));
        const violations = _collectRecentProjectWriteViolations(projectDir, bgStartedAt);
        if (violations.length > 0) {
          bgWriteViolationWarning = `\n\n[Background write violation: ${violations.length} file(s) changed outside authorized dirs temp/, output/, code/: ${violations.join(', ')}]`;
        }
      } catch { }
      // Auto-attach any output/ files the background command wrote after it started.
      // These are invisible to the normal diff-based auto-attach because the diff
      // snapshot was taken before the background thread had a chance to write them.
      if (responseCtx && Array.isArray(responseCtx.attachments)) {
        const projectDir = path.dirname(path.dirname(absolutePath));
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
                // Symlink-escape guard
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
      return JSON.stringify({ success: false, error: `File not found at path "${displayPath}".` });
    }
  }

  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (err) {
    if (err.code === 'EACCES') {
      return JSON.stringify({ success: false, error: `Access denied to file "${displayPath}".` });
    }
    return JSON.stringify({ success: false, error: `Cannot read file "${displayPath}": ${err.message}` });
  }

  if (stat.isDirectory()) {
    return JSON.stringify({ success: false, error: `Path is a directory, not a file.` });
  }

  const now = new Date();
  try {
    fs.utimesSync(absolutePath, now, now);
  } catch (err) { }

  const ext = path.extname(absolutePath).toLowerCase();
  const sanitizedPath = displayPath;

  // ── Size check before reading into memory ──
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    // Image size usually not a problem for memory but we check count later
  } else if (AUDIO_EXTS.includes(ext)) {
    if (stat.size > MAX_AUDIO_BYTES) {
      const maxMins = Math.round(MAX_AUDIO_BYTES / (16 * 1024 * 60));
      return JSON.stringify({ success: false, error: `Audio file exceeds size limit (max ~${maxMins} minutes).` });
    }
  } else if (VIDEO_EXTS.includes(ext)) {
    if (stat.size > MAX_VIDEO_BYTES) {
      return JSON.stringify({ success: false, error: `Video file exceeds size limit (${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB max). Trim it inside a project first.` });
    }
  } else if (stat.size > MAX_TEXT_BYTES * 4 && ext !== '.pdf') {
    // Heuristic: don't read more than 4x max text into memory if it's just text
    return JSON.stringify({ success: false, error: `File is too large to read as text (max ${MAX_TEXT_BYTES / 1024}KB).` });
  }

  const buffer = fs.readFileSync(absolutePath);

  // ── Images ──
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
    if (responseCtx.imagesReadCount >= MAX_IMAGE_READS) {
      return JSON.stringify({ success: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` });
    }
    responseCtx.imagesReadCount++;
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
    return [
      { type: 'text', text: `Contents of ${sanitizedPath}:` },
      mediaToContentPart(buffer, mimeMap[ext])
    ];
  }

  // ── Audio ──
  if (AUDIO_EXTS.includes(ext)) {
    const mimeMap = { '.ogg': 'audio/ogg', '.mp3': 'audio/mp3', '.wav': 'audio/wav', '.m4a': 'audio/m4a' };
    return [
      { type: 'text', text: `Audio contents of ${sanitizedPath}:` },
      mediaToContentPart(buffer, mimeMap[ext], {
        historyPath: rawPath.startsWith('history/') ? rawPath : null,
        historyUserId: rawPath.startsWith('history/') ? resolveStorageId(userCtx) : null,
      })
    ];
  }

  // ── Video ──
  if (VIDEO_EXTS.includes(ext)) {
    const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
    return [
      { type: 'text', text: `Video contents of ${sanitizedPath}:` },
      mediaToContentPart(buffer, mimeMap[ext], {
        historyPath: rawPath.startsWith('history/') ? rawPath : null,
        historyUserId: rawPath.startsWith('history/') ? resolveStorageId(userCtx) : null,
      })
    ];
  }

  // ── PDF ──
  if (ext === '.pdf') {
    const info = await extractTextFromPdfBuffer(buffer);
    if (!info.success) {
      return JSON.stringify({ success: false, error: `Failed to extract text from PDF.` });
    }
    let text = info.text;
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      text = Buffer.from(text).slice(0, MAX_TEXT_BYTES).toString('utf-8') + '\n\n[File truncated, too long]';
    }
    return `File: ${sanitizedPath}\n\n<Transcription>\n${text}\n</Transcription>${bgWriteViolationWarning}`;
  }

  // ── Text/Code ──
  let text = buffer.toString('utf-8');
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    // Correct byte-based truncation
    const truncatedBuffer = buffer.slice(0, MAX_TEXT_BYTES);
    text = truncatedBuffer.toString('utf-8') + '\n\n[File truncated, too long]';
  }

  return `File: ${sanitizedPath}\n\n${text}${bgWriteViolationWarning}`;
}

module.exports = { readFileTool };
