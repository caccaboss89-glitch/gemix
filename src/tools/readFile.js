// src/tools/readFile.js
//
// Tool used by the main brain to pull a specific file from chat history
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
    return {
      success: false,
      error: `File not found at path "${displayPath}". Use the filename from the [Attachment: ...] tag.`,
    };
  }

  let stat;
  try { stat = fs.statSync(abs); }
  catch (err) {
    if (err.code === 'EACCES') return { success: false, error: `Access denied to file "${displayPath}".` };
    return { success: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }

  if (stat.isDirectory()) return { success: false, error: 'Path is a directory, not a file.' };

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

  if (result.kind === 'error') return { success: false, error: result.error };
  if (result.kind === 'parts') {
    if (result.bumpImageCount) responseCtx.imagesReadCount++;
    return [
      { type: 'text', text: JSON.stringify({ success: true, message: `File loaded: ${displayPath}` }) },
      ...result.parts,
    ];
  }
  return {
    success: true,
    path: displayPath,
    content: result.content,
    ...(result.truncated ? { truncated: true } : {}),
  };
}

module.exports = { readFileTool };