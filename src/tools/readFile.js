// src/tools/readFile.js
//
// Tool used by the main brain to pull a specific file from chat history
// into the conversation. Two return shapes:
//
//   1. Text/code -> wrapped in <FileContent path="..." size="N"> with line
//      numbers, truncated past MAX_TEXT_BYTES.
//   2. Media (PDF, audio, video, image) -> exposed via the public attachment
//      tunnel as `{type:'input_file', file_url:'https://...'}` (or `image_url`
//      base64 for images) so xAI's Responses endpoint fetches and parses
//      them natively (OCR, STT, frame extraction).
//
// Scope: history only. The build sub-agent has its own read_file (see
// ai/buildAgent.js) for the workspace-tree case.

const fs = require('fs');
const path = require('path');
const { mediaToContentPart } = require('../utils/media');
const { ensureUserSkeleton, resolveStorageId, getHistoryDir } = require('../utils/userPaths');
const { getPublicAttachmentUrl } = require('../utils/tempFileServer');
const { createLogger } = require('../utils/logger');

const log = createLogger('ReadFileTool');

// Binary archives the model cannot inspect directly. We surface a clear
// refusal instead of silently failing.
const NON_READABLE_EXTS = new Set([
  '.exe', '.dll', '.so', '.bin', '.iso', '.dmg',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.jar',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
]);

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_IMAGE_READS = 10;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_PDF_BYTES = 48 * 1024 * 1024;

const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.m4a', '.flac', '.aac'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const AUDIO_MIME = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac' };
const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * Resolve a filename or "history/<...>" path to an absolute path under the
 * user's history dir. Refuses anything that escapes the history tree.
 */
function _resolveHistoryPath(rawPath, userCtx) {
  if (typeof rawPath !== 'string') return { ok: false, reason: 'Missing path.' };
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, reason: 'Empty path.' };
  if (trimmed.includes('\0')) return { ok: false, reason: 'Invalid path (null byte).' };

  const historyDir = getHistoryDir(userCtx);
  if (!historyDir) return { ok: false, reason: 'Cannot resolve user history.' };

  const rel = trimmed.replace(/^\/+/, '').replace(/^history[/\\]/i, '');
  if (!rel) return { ok: false, reason: 'Empty filename.' };

  const abs = path.resolve(historyDir, rel);
  if (!abs.startsWith(path.resolve(historyDir))) {
    return { ok: false, reason: 'Path escapes chat history.' };
  }
  return { ok: true, abs, displayPath: `history/${rel.replace(/\\/g, '/')}` };
}

/**
 * Build an input_file content part backed by the public attachment tunnel.
 * Returns the [textTag, inputFilePart] pair on success or a tool-result
 * error object on failure.
 */
function _buildInputFilePart(absPath, displayPath, mimetype) {
  let urlInfo;
  try {
    urlInfo = getPublicAttachmentUrl(absPath, path.basename(absPath), { kind: 'history', mimetype });
  } catch (err) {
    log.warn(`Failed to expose ${displayPath} via tunnel: ${err.message}`);
    return { success: false, error: `Cannot expose "${displayPath}" via attachment tunnel: ${err.message}` };
  }
  return [
    { type: 'text', text: `[Attachment: ${displayPath}]` },
    { type: 'input_file', file_url: urlInfo.url },
  ];
}

async function readFileTool(filePath, userCtx, responseCtx) {
  if (responseCtx.imagesReadCount === undefined) responseCtx.imagesReadCount = 0;

  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }
  ensureUserSkeleton(userCtx);

  const r = _resolveHistoryPath(filePath, userCtx);
  if (!r.ok) return { success: false, error: `Access denied: ${r.reason}` };
  const { abs, displayPath } = r;

  if (!fs.existsSync(abs)) {
    return { success: false, error: `File not found at path "${displayPath}".` };
  }

  let stat;
  try { stat = fs.statSync(abs); }
  catch (err) {
    if (err.code === 'EACCES') return { success: false, error: `Access denied to file "${displayPath}".` };
    return { success: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }

  if (stat.isDirectory()) return { success: false, error: 'Path is a directory, not a file.' };

  // Touch atime/mtime so the history pruner sees this file as recently used.
  const now = new Date();
  try { fs.utimesSync(abs, now, now); } catch { /* ignore */ }

  const ext = path.extname(abs).toLowerCase();
  const fileSize = stat.size;

  if (NON_READABLE_EXTS.has(ext)) {
    return { success: false, error: `Files with extension "${ext}" cannot be read directly. Delegate the task to the build sub-agent (which can run scripts on the file).` };
  }

  // -- Images --------------------------------------------------------------
  // Stay base64 inline. /v1/responses accepts image data URLs natively as
  // input_image; round-tripping through the tunnel would only add latency.
  if (IMAGE_EXTS.includes(ext)) {
    if (responseCtx.imagesReadCount >= MAX_IMAGE_READS) {
      return { success: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` };
    }
    if (fileSize === 0) return { success: false, error: `Image file "${displayPath}" is empty.` };
    responseCtx.imagesReadCount++;
    const buffer = fs.readFileSync(abs);
    return [
      { type: 'text', text: `[Attachment: ${displayPath}]` },
      mediaToContentPart(buffer, IMAGE_MIME[ext]),
    ];
  }

  // -- PDF / audio / video -------------------------------------------------
  if (ext === '.pdf') {
    if (fileSize > MAX_PDF_BYTES) return { success: false, error: `PDF "${displayPath}" exceeds the 48 MB xAI limit.` };
    return _buildInputFilePart(abs, displayPath, 'application/pdf');
  }
  if (AUDIO_EXTS.includes(ext)) {
    if (fileSize > MAX_AUDIO_BYTES) {
      const maxMins = Math.round(MAX_AUDIO_BYTES / (16 * 1024 * 60));
      return { success: false, error: `Audio file exceeds size limit (max ~${maxMins} minutes).` };
    }
    return _buildInputFilePart(abs, displayPath, AUDIO_MIME[ext]);
  }
  if (VIDEO_EXTS.includes(ext)) {
    if (fileSize > MAX_VIDEO_BYTES) {
      return { success: false, error: `Video file exceeds size limit (${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB max).` };
    }
    return _buildInputFilePart(abs, displayPath, VIDEO_MIME[ext]);
  }

  // -- Text / Code / unknown small file ------------------------------------
  if (fileSize > MAX_TEXT_BYTES * 4) {
    return { success: false, error: `File is too large to read as text (max ${MAX_TEXT_BYTES / 1024} KB).` };
  }
  const buffer = fs.readFileSync(abs);
  let text = buffer.toString('utf-8');
  const isTruncated = Buffer.byteLength(text) > MAX_TEXT_BYTES;
  if (isTruncated) {
    text = Buffer.from(buffer).slice(0, MAX_TEXT_BYTES).toString('utf-8') + '\n\n... (file truncated)';
  }
  const lines = text.split(/\r?\n/);
  const numberedText = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

  return {
    success: true,
    message: `<FileContent path="${displayPath}" size="${fileSize}"${isTruncated ? ' truncated="true"' : ''}>\n${numberedText}\n</FileContent>`,
  };
}

module.exports = { readFileTool };
