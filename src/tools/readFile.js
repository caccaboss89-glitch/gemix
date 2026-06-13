// src/tools/readFile.js
//
// Tool used by the main brain to pull specific file(s) from chat history
// into the conversation via aiFileDelivery (native input_file/input_image
// parts, or inline numbered text for text/code). Scope: history only —
// build sub-agent uses the same policy in ai/buildAgent.js for /workspace/
// and /skills/.

const fs = require('fs');
const path = require('path');

const { ensureUserSkeleton, resolveStorageId, getHistoryDir } = require('../utils/userPaths');
const { deliverReadFileFromPath } = require('../utils/aiFileDelivery');
const { mainReadFileBlockedMessage } = require('../config/nonReadableExts');
const { mimeForExtension } = require('../config/mimeExtensions');

function normalizeReadFilePaths(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'path must be a non-empty array of strings.' };
  }
  const paths = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'Each path must be a non-empty string.' };
    }
    paths.push(item.trim());
  }
  return { ok: true, paths };
}

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

async function _readOneHistoryFile(filePath, userCtx, responseCtx) {
  const r = _resolveHistoryPath(filePath, userCtx);
  if (!r.ok) return { kind: 'error', path: filePath, error: `Access denied: ${r.reason}` };
  const { abs, displayPath } = r;

  if (!fs.existsSync(abs)) {
    return {
      kind: 'error',
      path: displayPath,
      error: `File not found at path "${displayPath}". Use the filename from the [Attachment: ...] tag.`,
    };
  }

  let stat;
  try { stat = fs.statSync(abs); }
  catch (err) {
    if (err.code === 'EACCES') {
      return { kind: 'error', path: displayPath, error: `Access denied to file "${displayPath}".` };
    }
    return { kind: 'error', path: displayPath, error: `Cannot read file "${displayPath}": ${err.message}` };
  }

  if (stat.isDirectory()) {
    return { kind: 'error', path: displayPath, error: 'Path is a directory, not a file.' };
  }

  const now = new Date();
  try { fs.utimesSync(abs, now, now); } catch { /* ignore */ }

  const ext = path.extname(abs).toLowerCase();
  const result = await deliverReadFileFromPath({
    absPath: abs,
    displayPath,
    contentType: mimeForExtension(ext),
    imagesReadCount: responseCtx.imagesReadCount,
    blockedMessage: mainReadFileBlockedMessage(ext),
  });

  if (result.kind === 'error') return { kind: 'error', path: displayPath, error: result.error };
  if (result.kind === 'parts') {
    if (result.bumpImageCount) responseCtx.imagesReadCount++;
    return { kind: 'parts', displayPath, parts: result.parts };
  }
  return {
    kind: 'inline',
    displayPath,
    content: result.content,
    truncated: result.truncated,
  };
}

async function readFileTool(paths, userCtx, responseCtx) {
  if (responseCtx.imagesReadCount === undefined) responseCtx.imagesReadCount = 0;

  const norm = normalizeReadFilePaths(paths);
  if (!norm.ok) return { success: false, error: norm.error };

  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID for this context.' };
  }
  ensureUserSkeleton(userCtx);

  const fileResults = [];
  const mediaParts = [];
  let hasMediaParts = false;

  for (const filePath of norm.paths) {
    const one = await _readOneHistoryFile(filePath, userCtx, responseCtx);
    if (one.kind === 'error') {
      fileResults.push({ path: one.path, success: false, error: one.error });
      continue;
    }
    if (one.kind === 'parts') {
      hasMediaParts = true;
      fileResults.push({ path: one.displayPath, success: true });
      mediaParts.push(...one.parts);
      continue;
    }
    fileResults.push({
      path: one.displayPath,
      success: true,
      content: one.content,
      ...(one.truncated ? { truncated: true } : {}),
    });
  }

  const payload = {
    success: fileResults.every(f => f.success),
    files: fileResults,
  };

  if (hasMediaParts) {
    return [
      { type: 'text', text: JSON.stringify(payload) },
      ...mediaParts,
    ];
  }
  return payload;
}

module.exports = { readFileTool, normalizeReadFilePaths };
