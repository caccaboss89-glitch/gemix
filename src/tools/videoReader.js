// src/tools/videoReader.js
//
// read_video: load one video that is already in this chat's history.
//
// Videos in the current message (and in the message the user replied to) are
// attached natively as usual. Older ones are deferred by the history builders
// (aiFileDelivery.js `deferVideo`) and reach the model only through this tool,
// because xAI expands a video into roughly one frame per second: leaving every
// clip in the window would bury the conversation under hundreds of images.
//
// Only history filenames are accepted — the exact name inside an
// [Attachment: …] tag. There is no URL path: the duration and size gates need
// the file on disk, and fetching arbitrary remote video would be a new capability
// rather than a fix for our own context budget. Web images and X videos are
// already covered by xAI's own server-side tools.

import fs from 'fs';
import path from 'path';
import { buildXaiFileParts, isVideoAttachment  } from '../utils/aiFileDelivery.js';
import { getHistoryDir  } from '../utils/userPaths.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import constants from '../config/constants.js';
import { createLogger  } from '../utils/logger.js';

const log = createLogger('VideoReader');

/**
 * Resolve a history filename to an absolute path inside this chat's history dir.
 * Rejects paths that try to escape it.
 * @param {string} historyDir
 * @param {string} filename
 * @returns {string|null}
 */
function _resolveHistoryVideo(historyDir, filename) {
  const target = path.basename(String(filename || '').trim());
  if (!target) return null;
  const abs = path.join(historyDir, target);
  try {
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * read_video implementation.
 *
 * @param {object} args - { filename: string }
 * @param {object} userCtx - resolves the chat's history dir (userPaths.js)
 * @returns {Promise<object|Array>} JSON payload, or [text, input_file] parts on success
 */
async function readVideo(args, userCtx) {
  const filename = String(args?.filename || '').trim();
  if (/^https?:\/\//i.test(filename)) {
    return {
      success: false,
      error: 'read_video only takes a filename from an [Attachment: ...] tag in this chat, not a URL. '
        + 'Videos hosted elsewhere on the web cannot be opened.'
    };
  }

  let historyDir = null;
  try { historyDir = getHistoryDir(userCtx); } catch { historyDir = null; }
  if (!historyDir) {
    return { success: false, error: 'No chat history storage is available in this context.' };
  }

  const absPath = _resolveHistoryVideo(historyDir, filename);
  if (!absPath) {
    return {
      success: false,
      error: `No file named "${filename}" in this chat's history. Use the exact name shown inside its [Attachment: ...] tag.`
    };
  }

  const mimetype = mimeForExtension(path.extname(absPath));
  if (!isVideoAttachment(absPath, mimetype)) {
    return {
      success: false,
      error: `"${filename}" is not a video. Files that are not videos are already attached to the conversation.`
    };
  }

  const built = await buildXaiFileParts(absPath, path.basename(absPath), { mimetype });
  if (!built.success) {
    log.warn(`read_video failed for "${filename}": ${built.error}`);
    return { success: false, error: built.error };
  }

  const part = built.parts.find(p => p.type === 'input_file');
  if (!part) {
    return { success: false, error: `Could not attach "${filename}" to this turn.` };
  }

  const payload = {
    success: true,
    filename: path.basename(absPath),
    message: `Video "${path.basename(absPath)}" is attached to this turn (max ${constants.MAX_VIDEO_DURATION_S}s). Watch it and answer.`
  };
  return [{ type: 'text', text: JSON.stringify(payload) }, part];
}

export { readVideo 
};
