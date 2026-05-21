// src/tools/attachFile.js
// Push an existing file from the user's storage into the delivery buffer.
// Cross-platform:
//   - Discord: chat history only.
//   - WhatsApp: /readonly/{searched_images}/, /workspace/{temp,code}/...
//     (output/ is excluded: those files already land in the buffer
//     automatically when written.)
// All tools that produce files share the same buffer; callers do NOT need
// to re-attach output/ files manually.

const fs = require('fs');
const path = require('path');
const {
  isPathAllowed,
  ensureUserSkeleton,
  resolveStorageId,
} = require('../utils/userPaths');
const { getCurrentProject } = require('../utils/projectState');
const { createLogger } = require('../utils/logger');

const log = createLogger('AttachFile');

const MAX_ATTACH_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB per single attachment (fallback link handles large files)

const MIME_BY_EXT = {
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

function _mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * attach_file tool.
 * @param {object} args  { path: string }
 * @param {object} userCtx
 * @param {object} responseCtx  attachments[] is mutated in place
 */
async function attachFileTool(args, userCtx, responseCtx) {
  const rawPath = args && args.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { success: false, error: 'Missing required argument "path".' };
  }
  if (!resolveStorageId(userCtx)) {
    return { success: false, error: 'Could not resolve storage ID.' };
  }
  ensureUserSkeleton(userCtx);

  const currentProject = await getCurrentProject(userCtx);
  const check = isPathAllowed(userCtx, rawPath, { op: 'read', currentProject });
  if (!check.ok) {
    return { success: false, error: `attach_file refused: ${check.reason}` };
  }
  // Chat history is intentionally NOT a valid source: the user already sees
  // those files in their chat. Refuse with a clear message so the AI
  // does not loop trying to re-deliver them.
  if (check.zone === 'history') {
    return {
      success: false,
      error: 'attach_file refused: files from chat history are already visible to the user — do not re-deliver them. Use attach_file only for searched_images/ or /workspace/{temp|code}/...',
    };
  }
  if (check.zone === 'skills') {
    return { success: false, error: 'attach_file refused: skills/ is read-only AI guidance, not deliverable content.' };
  }
  if (check.zone === 'project_sub' && check.subdir === 'output') {
    return {
      success: false,
      error: 'attach_file refused: output/ files are already in the delivery buffer — do not attach them again. Use attach_file only for /workspace/{temp|code}/ or searched_images/.',
    };
  }

  const abs = check.absPath;
  if (!fs.existsSync(abs)) {
    return { success: false, error: `File not found: ${rawPath}` };
  }

  let stat;
  try { stat = fs.statSync(abs); }
  catch (e) { return { success: false, error: `Cannot stat file: ${e.message}` }; }

  if (stat.isDirectory()) {
    return { success: false, error: 'Path is a directory. attach_file requires a single file. Use bash to zip a folder first.' };
  }
  if (stat.size === 0) {
    return { success: false, error: 'File is empty.' };
  }
  if (stat.size > MAX_ATTACH_BYTES) {
    return { success: false, error: `File too large (${(stat.size / (1024 * 1024 * 1024)).toFixed(1)} GB; max 20 GB). Please contact the Admin for manual delivery.` };
  }

  // Avoid attaching the same file twice in the same response.
  const alreadyAttached = (responseCtx.attachments || []).some(a => a.filePath && path.resolve(a.filePath) === path.resolve(abs));
  if (alreadyAttached) {
    return { success: true, already_attached: true, name: path.basename(abs), path: rawPath };
  }

  if (!Array.isArray(responseCtx.attachments)) responseCtx.attachments = [];
  responseCtx.attachments.push({
    name: path.basename(abs),
    mimetype: _mimeFor(abs),
    filePath: abs,
  });

  log.info(`attached ${rawPath} (${stat.size} bytes)`);
  return {
    success: true,
    name: path.basename(abs),
    path: rawPath,
    size: stat.size,
    message: 'File pushed to the delivery buffer.',
  };
}

module.exports = { attachFileTool };
