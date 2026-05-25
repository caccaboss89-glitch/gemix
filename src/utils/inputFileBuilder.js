// src/utils/inputFileBuilder.js
//
// Pre-call hook that prepares non-image media (PDF, audio, video, plain text)
// for the xAI Responses API.
//
// Why this exists:
//   - xAI's /v1/responses endpoint accepts native attachments as
//     `{type:'input_file', file_url:'https://…'}`. Server-side, xAI fetches
//     the file once, runs OCR/STT/frame extraction, and folds the parsed
//     content into the prompt automatically.
//   - This replaces the three pre-pass modules we used to run before each
//     LLM call (audio STT, video describer, PDF parser microservice) and
//     the bespoke tag injection that came with them. None of that is
//     needed anymore.
//   - Images stay base64 inline (`image_url` data URL). The Responses adapter
//     translates them to `input_image` and they work natively. No need to push
//     every image through the tunnel — xAI accepts both.
//
// What this module does NOT do:
//   - It does not pre-validate file size / duration limits anymore. xAI's
//     own limits (48 MB/file, ~2-3 min practical video) take care of that.
//     If a file exceeds the model's limit the API returns an explicit error
//     and the handler reports it to the user.
//   - It does not modify chat history entries. Pre-pass runs on the
//     in-memory `messages[]` array right before the call; history rows in
//     storage are untouched.
//
// Threading: each pass walks `messages` once and mutates content arrays in
// place. Concurrent calls are isolated (each handleMessage gets its own
// messages array).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { getPublicAttachmentUrl, TEMP_DIR } = require('./tempFileServer');
const { DATA_DIR } = require('../config/constants');
const { notifyAdmin } = require('./adminNotifier');

const log = createLogger('InputFileBuilder');

// MIME prefixes we hand off as input_file URLs. Images go through the
// adapter's `input_image` path (base64 data URLs work fine on /v1/responses).
const URL_PASSTHROUGH_PREFIXES = ['application/', 'audio/', 'video/', 'text/'];

// Extension → fallback name when the original filename is unknown.
const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/json': '.json',
  'application/xml': '.xml',
};

function _shouldPassAsUrl(mimetype) {
  if (typeof mimetype !== 'string') return false;
  const lower = mimetype.toLowerCase();
  return URL_PASSTHROUGH_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function _extractMimeFromDataUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  if (!m) return null;
  return { mimetype: m[1].split(';')[0].trim(), base64: m[2] };
}

function _basenameForPart(part, mimetype) {
  // Preferred order: explicit filename hint → history path basename →
  // synthesized random name with a sensible extension.
  if (typeof part?._fileName === 'string' && part._fileName.trim()) {
    return path.basename(part._fileName.trim());
  }
  if (typeof part?._historyPath === 'string' && part._historyPath.trim()) {
    return path.basename(part._historyPath.trim());
  }
  const ext = EXT_BY_MIME[mimetype] || '';
  return `attachment_${crypto.randomBytes(6).toString('hex')}${ext}`;
}

/**
 * Resolve the on-disk path of a content part, if it can be located without
 * spilling the base64 to disk. Returns null when no on-disk source is known
 * (the caller will materialize the buffer to TEMP_DIR instead).
 *
 * Currently we only resolve `_historyPath` + `_historyUserId`, which the
 * platform handlers attach when a media part is sourced from chat history.
 */
function _resolveOnDiskPath(part) {
  const historyPath = typeof part?._historyPath === 'string' ? part._historyPath.trim() : '';
  const historyUserId = typeof part?._historyUserId === 'string' ? part._historyUserId.trim() : '';
  if (!historyPath || !historyUserId) return null;

  const safeUserId = historyUserId.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  const cleanRel = historyPath.replace(/^history\//, '').replace(/^\/+/, '');
  if (cleanRel.includes('..') || path.isAbsolute(cleanRel)) return null;

  const abs = path.join(DATA_DIR, 'users', safeUserId, 'history', cleanRel);
  return fs.existsSync(abs) ? abs : null;
}

function _materializeToTemp(base64, originalName) {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new Error('Empty base64 buffer');
  const stem = `inline_${crypto.randomBytes(8).toString('hex')}`;
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(TEMP_DIR, `${stem}_${safeName}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/**
 * Convert a single base64-image_url content part into a Responses-ready
 * input_file part. Returns null when no transformation is needed (image
 * MIME types stay as-is).
 *
 * The function is best-effort: if URL registration fails (tunnel down,
 * disk full, …) it returns null and the caller falls back to leaving the
 * original part in place. The resulting downstream API error, if any,
 * surfaces clearly via the handler's error path.
 *
 * @param {object} part
 * @returns {{type:'input_file', file_url:string} | null}
 */
function _convertPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type !== 'image_url' || !part.image_url || typeof part.image_url.url !== 'string') return null;

  const parsed = _extractMimeFromDataUrl(part.image_url.url);
  if (!parsed) return null;

  // Pure images stay where they are — adapter handles them as input_image.
  if (!_shouldPassAsUrl(parsed.mimetype)) return null;

  const originalName = _basenameForPart(part, parsed.mimetype);
  const onDiskPath = _resolveOnDiskPath(part);

  let filePath;
  let kind;
  if (onDiskPath) {
    filePath = onDiskPath;
    kind = 'history';
  } else {
    try {
      filePath = _materializeToTemp(parsed.base64, originalName);
      kind = 'temp';
    } catch (err) {
      log.warn(`Failed to materialize ${originalName} (${parsed.mimetype}): ${err.message}`);
      return null;
    }
  }

  let urlInfo;
  try {
    urlInfo = getPublicAttachmentUrl(filePath, originalName, {
      kind,
      mimetype: parsed.mimetype,
    });
  } catch (err) {
    log.warn(`Failed to register ${originalName} for tunnel exposure: ${err.message}`);
    notifyAdmin('InputFileBuilder', `Tunnel registration failed for ${originalName}: ${err.message}`).catch(() => {});
    return null;
  }

  log.debug(`📎 ${originalName} → ${kind} URL (mime=${parsed.mimetype})`);
  return { type: 'input_file', file_url: urlInfo.url };
}

/**
 * Walk every message and rewrite non-image media parts into input_file URL
 * parts. Mutates the array in place. Safe to call repeatedly: parts that are
 * already `input_file` (or anything else this builder doesn't recognise)
 * pass through untouched.
 *
 * @param {Array} messages - chat-style messages array
 * @returns {Promise<{ converted: number, skipped: number }>}
 */
async function prepareInputFilesInMessages(messages) {
  let converted = 0;
  let skipped = 0;
  if (!Array.isArray(messages)) return { converted, skipped };

  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (!part || part.type !== 'image_url') continue;
      const replacement = _convertPart(part);
      if (replacement) {
        msg.content[i] = replacement;
        converted++;
      } else if (typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:')) {
        const probe = _extractMimeFromDataUrl(part.image_url.url);
        if (probe && _shouldPassAsUrl(probe.mimetype)) skipped++;
      }
    }
  }

  if (converted > 0 || skipped > 0) {
    log.info(`📎 prepareInputFilesInMessages: converted=${converted}, skipped=${skipped}`);
  }
  return { converted, skipped };
}

module.exports = {
  prepareInputFilesInMessages,
};
