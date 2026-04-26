// src/tools/attachFile.js
// Register an existing file from the user's personal cloud as an attachment
// for the current response. Files are AUTO-DELIVERED in the current chat.
// Cross-platform:
//   - Discord: history/ only (Discord client auto-delivers responseCtx.attachments).
//   - WhatsApp: permanent/, searched_images/, projects/<*>/{figures,temp,output,code}/...
//     Files are auto-included in the current chat response (no send_whatsapp_message needed).
//     Use send_whatsapp_message / send_email ONLY to send to OTHER recipients.

const fs = require('fs');
const path = require('path');
const {
  isPathAllowed,
  ensureUserSkeleton,
  resolveStorageId,
} = require('../utils/userPaths');
const { createLogger } = require('../utils/logger');

const log = createLogger('AttachFile');

const MAX_ATTACH_BYTES = 100 * 1024 * 1024; // 100 MB per single attachment

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

  const check = isPathAllowed(userCtx, rawPath, { op: 'read' });
  if (!check.ok) {
    return { success: false, error: `attach_file refused: ${check.reason}` };
  }
  // history/ is intentionally NOT a valid source: the user already sees
  // those files in their chat. Refuse with a clear message so the AI
  // does not loop trying to re-deliver them.
  if (check.zone === 'history') {
    return {
      success: false,
      error: 'attach_file refused: files in history/ are already visible to the user in the chat — do not re-deliver them. Use attach_file only for permanent/, searched_images/ or projects/<name>/{figures|temp|output|code}/...',
    };
  }
  if (check.zone === 'skills') {
    return { success: false, error: 'attach_file refused: skills/ is read-only AI guidance, not deliverable content.' };
  }

  const abs = check.absPath;
  if (!fs.existsSync(abs)) {
    return { success: false, error: `File not found: ${rawPath}` };
  }

  let stat;
  try { stat = fs.statSync(abs); }
  catch (e) { return { success: false, error: `Cannot stat file: ${e.message}` }; }

  if (stat.isDirectory()) {
    return { success: false, error: 'Path is a directory. attach_file requires a single file. Use code_execution / bash to zip a folder first.' };
  }
  if (stat.size === 0) {
    return { success: false, error: 'File is empty.' };
  }
  if (stat.size > MAX_ATTACH_BYTES) {
    return { success: false, error: `File too large (${(stat.size / 1048576).toFixed(1)} MB; max ${MAX_ATTACH_BYTES / 1048576} MB). Compress it first.` };
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
    message_for_ai: 'File buffered for delivery in the current chat (auto-delivered with your reply). To send to other recipients, use send_whatsapp_message / send_email with includeAttachments=true.',
  };
}

module.exports = { attachFileTool };
