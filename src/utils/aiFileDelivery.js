// Central policy for how files reach xAI on /v1/responses.
//
// Every supported file is exposed through a public URL (tmpfile.link upload,
// see utils/xaiUpload.js) and attached natively:
//   - supported image types            -> { type: 'input_image', image_url }
//   - everything else (text/code, PDF, Office, archives, audio, video, ...)
//                                      -> { type: 'input_file', file_url }
// xAI fetches the URL server-side and parses it natively (OCR/STT/vision,
// Office and archive parsing, semantic file search) without inlining the
// content into the prompt. Only raw binaries (.exe, .iso, ...) stay tag-only.
//
// read_file in the build sub-agent returns plain text/code content inline
// in the JSON tool result (numbered lines) — exact bytes matter for edit_file.
// The main brain has no read_file: user-side files are attached natively
// (input_file/input_image) on the turn they appear, current or in history.
// Assistant-side history entries (including GemiX voice) stay [Attachment]
// tags only — that role cannot carry native file parts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DATA_DIR,
  MAX_IMAGE_BYTES,
  MAX_HISTORY_MEDIA_IMAGES,
  MAX_HISTORY_MEDIA_FILES,
} = require('../config/constants');
const { mimeForExtension, mimeBase } = require('../config/mimeExtensions');
const { isNonReadableExt, mainReadFileBlockedMessage } = require('../config/nonReadableExts');
const { tempDirForOwner } = require('./tempFileServer');
const { syncFileToHistory } = require('./historySync');
const { uploadFileForXai } = require('./xaiUpload');
const { buildAttachmentTag } = require('./media');
const {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  resolveMediaDurationSec,
} = require('./mediaIngressLimits');
const { getMediaDurationSec } = require('./mediaDuration');
const { createLogger } = require('./logger');

const log = createLogger('AiFileDelivery');

const DELIVERY_MODE = {
  IMAGE: 'image',     // input_image (xAI-supported image types only)
  FILE: 'file',       // input_file (documents, code, PDF, Office, archives, audio, video)
  TAG_ONLY: 'tag_only', // raw binaries - [Attachment] tag only
};

/** Image types accepted by xAI as input_image. Everything else goes input_file. */
const XAI_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico']);
const XAI_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/x-icon', 'image/vnd.microsoft.icon',
]);

const AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const OFFICE_ARCHIVE_EXTS = new Set([
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
  '.zip', '.jar', '.7z', '.rar', '.tar', '.gz',
]);

const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.rst', '.log', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.svg', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sh', '.bash', '.zsh', '.bat', '.ps1', '.makefile', '.dockerfile',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyw', '.rb', '.php',
  '.java', '.kt', '.scala', '.groovy', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.jl',
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.sql', '.graphql', '.gql',
  '.patch', '.diff',
]);

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXTRA = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-shellscript',
]);

// Per-call caps on history files re-attached natively to the turn.
//   - images: vision-processed every call (expensive)
//   - files:  documents/audio/video (input_file).
const MAX_IMAGE_READS = MAX_HISTORY_MEDIA_IMAGES;
const MAX_FILE_READS = MAX_HISTORY_MEDIA_FILES;
// Size caps for xAI ingestion.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_PDF_BYTES = 48 * 1024 * 1024;   // xAI PDF limit
const MAX_DOC_BYTES = 48 * 1024 * 1024;   // generic documents/archives

/** Max bytes for build read_file inline text/code reads. */
const READ_FILE_TEXT_MAX_BYTES = 50 * 1024;

function _extOf(name) {
  return path.extname(name || '').toLowerCase();
}

function isTextualFile(filename, mimetype) {
  const mime = mimeBase(mimetype || '');
  if (mime) {
    if (TEXT_MIME_PREFIXES.some(p => mime.startsWith(p)) && !mime.startsWith('text/rtf')) return true;
    if (TEXT_MIME_EXTRA.has(mime)) return true;
  }
  return TEXT_FILE_EXTS.has(_extOf(filename));
}

/**
 * Decide how a file is shown to xAI: input_image, input_file or tag-only.
 */
function classifyAiFileDelivery(name, contentType) {
  const ext = _extOf(name);
  const ct = mimeBase(contentType || '');

  if (isNonReadableExt(ext)) return DELIVERY_MODE.TAG_ONLY;
  if (XAI_IMAGE_EXTS.has(ext) || XAI_IMAGE_MIMES.has(ct)) return DELIVERY_MODE.IMAGE;

  if (
    ext === '.pdf' || ct === 'application/pdf'
    || AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext)
    || OFFICE_ARCHIVE_EXTS.has(ext)
    || isTextualFile(name, contentType)
    // Unsupported image subtypes (gif, bmp, tiff, ...) are still parsed
    // server-side as generic files.
    || ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/')
  ) {
    return DELIVERY_MODE.FILE;
  }

  return DELIVERY_MODE.TAG_ONLY;
}

// -- Media kind + validation --------------------------------------------------

function _mediaKindFor(name, contentType) {
  const ext = _extOf(name);
  const ct = mimeBase(contentType || '');
  if (XAI_IMAGE_EXTS.has(ext) || XAI_IMAGE_MIMES.has(ct)) return 'image';
  if (ext === '.pdf' || ct === 'application/pdf') return 'pdf';
  if (ext === '.webm') {
    if (ct === 'audio/webm' || (ct.startsWith('audio/') && !ct.startsWith('video/'))) return 'audio';
    return 'video';
  }
  if (AUDIO_EXTS.has(ext) || ct.startsWith('audio/')) return 'audio';
  if (VIDEO_EXTS.has(ext) || ct.startsWith('video/')) return 'video';
  return 'doc';
}

/**
 * Validate a file on disk before exposing it to xAI (size, duration, image
 * count budget, PDF header). Returns { ok, bumpImageCount? } or { ok:false, error }.
 */
async function validateXaiFile(absPath, displayPath, opts = {}) {
  const contentType = opts.contentType || opts.mimetype || '';
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (err) {
    return { ok: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }
  const fileSize = stat.size;
  if (fileSize === 0) {
    return { ok: false, error: `File "${displayPath}" is empty (0 bytes).` };
  }

  const kind = _mediaKindFor(path.basename(absPath), contentType);

  if (kind === 'image') {
    const count = opts.imagesReadCount ?? 0;
    if (count >= MAX_IMAGE_READS) {
      return { ok: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` };
    }
    if (fileSize > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image "${displayPath}" exceeds the size limit (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).` };
    }
    return { ok: true, bumpImageCount: true };
  }

  if (kind === 'pdf') {
    if (fileSize > MAX_PDF_BYTES) {
      return { ok: false, error: `PDF "${displayPath}" exceeds the 48 MB xAI limit.` };
    }
    try {
      const fd = fs.openSync(absPath, 'r');
      const header = Buffer.alloc(5);
      fs.readSync(fd, header, 0, 5, 0);
      fs.closeSync(fd);
      if (header.toString('ascii') !== '%PDF-') {
        return { ok: false, error: `PDF "${displayPath}" does not look like a valid PDF file.` };
      }
    } catch (err) {
      return { ok: false, error: `Cannot validate PDF "${displayPath}": ${err.message}` };
    }
    return { ok: true };
  }

  if (kind === 'audio') {
    if (fileSize > MAX_AUDIO_BYTES) {
      return { ok: false, error: `Audio file exceeds size limit (${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB max).` };
    }
    const audioDur = await getMediaDurationSec(fs.readFileSync(absPath), _extOf(absPath).slice(1) || 'ogg');
    if (isAudioOverDurationLimit(audioDur)) {
      return {
        ok: false,
        error: `Audio exceeds the duration limit (${Math.round(audioDur)}s). Tell the user the clip is too long for native playback in chat.`,
      };
    }
    return { ok: true };
  }

  if (kind === 'video') {
    if (fileSize > MAX_VIDEO_BYTES) {
      return { ok: false, error: `Video file exceeds size limit (${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB max).` };
    }
    const videoDur = await getMediaDurationSec(fs.readFileSync(absPath), _extOf(absPath).slice(1) || 'mp4');
    if (isVideoOverDurationLimit(videoDur)) {
      return {
        ok: false,
        error: `Video exceeds the duration limit (${Math.round(videoDur)}s). Tell the user the clip is too long for native playback in chat.`,
      };
    }
    return { ok: true };
  }

  if (fileSize > MAX_DOC_BYTES) {
    return { ok: false, error: `File "${displayPath}" exceeds the size limit (${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB max).` };
  }
  return { ok: true };
}

// -- Part building --------------------------------------------------------------

function _filePartFor(mode, url) {
  return mode === DELIVERY_MODE.IMAGE
    ? { type: 'input_image', image_url: url }
    : { type: 'input_file', file_url: url };
}

/**
 * Validate + upload a file on disk and return the xAI content parts
 * ([Attachment] label + input_image/input_file).
 *
 * @returns {Promise<{ success: true, url: string, parts: object[], bumpImageCount?: boolean }
 *   | { success: false, error: string }>}
 */
async function buildXaiFileParts(absPath, displayPath, opts = {}) {
  const ext = _extOf(absPath);
  const mimetype = opts.mimetype || opts.contentType
    || mimeForExtension(ext, 'application/octet-stream', opts.contentType);
  const mode = classifyAiFileDelivery(path.basename(absPath), mimetype);
  if (mode === DELIVERY_MODE.TAG_ONLY) {
    return { success: false, error: `File type not supported for xAI ingestion: "${displayPath}".` };
  }

  const gate = await validateXaiFile(absPath, displayPath, { ...opts, contentType: mimetype });
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }

  let url;
  try {
    url = await uploadFileForXai(absPath, path.basename(displayPath || absPath), mimetype, {
      forceRefresh: opts.forceRefresh === true,
    });
  } catch (err) {
    log.warn(`Upload failed for ${displayPath}: ${err.message}`);
    return { success: false, error: `Cannot expose "${displayPath}" to xAI: ${err.message}` };
  }

  const nativePart = _filePartFor(mode, url);
  nativePart._xaiSourcePath = absPath;

  return {
    success: true,
    url,
    parts: [
      { type: 'text', text: `[Attachment: ${displayPath}]` },
      nativePart,
    ],
    bumpImageCount: gate.bumpImageCount,
  };
}

/**
 * Validate + upload a file on disk and return its public URL only (image/video
 * generation references, build round-1 ingestion).
 */
async function exposeXaiUrlFromAbsPath(absPath, displayPath, opts = {}) {
  const built = await buildXaiFileParts(absPath, displayPath, opts);
  if (!built.success) return built;
  return { success: true, url: built.url, bumpImageCount: built.bumpImageCount, sourcePath: absPath };
}

// -- Build read_file: inline numbered text ------------------------------------

function _truncateUtf8Text(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return {
    text: buf.slice(0, end).toString('utf-8') + '\n... (file truncated)',
    truncated: true,
  };
}

/**
 * Read a text/code file from disk as numbered lines ("1: ..."), capped at
 * READ_FILE_TEXT_MAX_BYTES. Returned as plain content for the JSON tool
 * result - exact bytes, no markup.
 * @returns {{ ok: true, content: string, truncated: boolean } | { ok: false, error: string }}
 */
function readNumberedTextFromPath(absPath, displayPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? READ_FILE_TEXT_MAX_BYTES;
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (err) {
    return { ok: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }
  if (stat.size > maxBytes * 4) {
    return { ok: false, error: `File is too large to read as text (max ${maxBytes / 1024} KB).` };
  }
  try {
    let text = fs.readFileSync(absPath).toString('utf-8');
    let truncated = false;
    if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
      const cut = _truncateUtf8Text(text, maxBytes);
      text = cut.text;
      truncated = cut.truncated;
    }
    const numbered = text.split(/\r?\n/).map((line, i) => `${i + 1}: ${line}`).join('\n');
    return { ok: true, content: numbered, truncated };
  } catch (err) {
    return { ok: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }
}

// -- Ingress (current turn, quotes, history) -------------------------------------

function resolveHistoryAbsPath(historyUserId, historyPath) {
  const uid = typeof historyUserId === 'string' ? historyUserId.trim() : '';
  const rel = typeof historyPath === 'string' ? historyPath.trim() : '';
  if (!uid || !rel) return null;

  const safeUserId = uid.replace(/[^a-zA-Z0-9_@.-]/g, '_');
  const cleanRel = rel.replace(/^history\//, '').replace(/^\/+/, '');
  if (cleanRel.includes('..') || path.isAbsolute(cleanRel)) return null;

  const abs = path.join(DATA_DIR, 'users', safeUserId, 'history', cleanRel);
  return fs.existsSync(abs) ? abs : null;
}

function _materializeBufferToTemp(buffer, originalName, ownerKey) {
  const dir = tempDirForOwner(ownerKey);
  const stem = `ingress_${crypto.randomBytes(8).toString('hex')}`;
  const safeName = (originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, `${stem}_${safeName}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function _resolveIngressTarget(opts) {
  const {
    syncedPath,
    name,
    contentType = '',
    historyStorageId,
    fetchBuffer,
    ownerKey = null,
  } = opts;

  const ext = _extOf(name);
  const mimetype = mimeForExtension(
    ext,
    mimeBase(contentType) || 'application/octet-stream',
    contentType,
  );
  const displayName = path.basename(syncedPath || name || 'file');

  let absPath = syncedPath && historyStorageId
    ? resolveHistoryAbsPath(historyStorageId, syncedPath)
    : null;

  if (absPath) {
    try {
      const st = fs.statSync(absPath);
      if (!st.isFile() || st.size === 0) {
        log.warn(`History file empty or missing (${displayName}), re-fetching buffer`);
        absPath = null;
      }
    } catch {
      absPath = null;
    }
  }

  if (!absPath) {
    const buffer = typeof fetchBuffer === 'function' ? await fetchBuffer() : null;
    if (!buffer || !buffer.length) {
      return { error: 'file unavailable (empty or download failed)' };
    }
    try {
      absPath = _materializeBufferToTemp(buffer, displayName, ownerKey);
    } catch (err) {
      log.warn(`Failed to materialize ${displayName}: ${err.message}`);
      return { error: err.message };
    }
  }

  return { absPath, displayName, mimetype };
}

function _durationSkipResult(tag, kind, durationSec) {
  const note = kind === 'audio'
    ? formatAudioTooLongNote(durationSec)
    : formatVideoTooLongNote(durationSec);
  return {
    tag,
    contentParts: [],
    textFragment: `${tag}${note} `,
    overDurationLimit: kind,
    durationNote: note.trim(),
  };
}

/**
 * Turn a synced attachment into the [Attachment] tag + native content parts.
 *
 * @param {object} opts
 * @param {string|null} opts.syncedPath - history-relative filename (when synced).
 * @param {string} opts.name
 * @param {string} [opts.contentType]
 * @param {Function} opts.fetchBuffer - async () => Buffer|null
 * @param {string} opts.historyStorageId
 * @param {number} [opts.metadataDurationSec]
 * @param {string|null} [opts.ownerKey] - temp-dir isolation key for buffer files.
 * @param {boolean} [opts.tagOnly] - emit the tag without parts (assistant-side
 *   history entries, whose role cannot carry input parts).
 * @returns {Promise<{ tag: string, contentParts: object[], textFragment: string,
 *   overDurationLimit?: string, durationNote?: string }>}
 */
async function deliverSyncedAttachment(opts) {
  const {
    syncedPath,
    name,
    contentType = '',
    fetchBuffer,
    metadataDurationSec = 0,
    tagOnly = false,
  } = opts;

  const tag = buildAttachmentTag(syncedPath, name);
  const mode = classifyAiFileDelivery(name, contentType);
  const kind = _mediaKindFor(name, contentType);

  if (mode === DELIVERY_MODE.TAG_ONLY) {
    return { tag, syncedPath: syncedPath || null, contentParts: [], textFragment: `${tag} ` };
  }

  // Duration gates run before any upload so over-limit clips are skipped with
  // an inline note instead of being attached. Prefer metadata / the synced
  // history file on disk; only fall back to fetching the platform buffer.
  if (kind === 'audio' || kind === 'video') {
    try {
      const historyAbsPath = syncedPath && opts.historyStorageId
        ? resolveHistoryAbsPath(opts.historyStorageId, syncedPath)
        : null;
      let probeBuffer = null;
      if (!historyAbsPath && !(Number(metadataDurationSec) > 0) && typeof fetchBuffer === 'function') {
        probeBuffer = await fetchBuffer();
      }
      const dur = await resolveMediaDurationSec({
        metadataSec: metadataDurationSec,
        buffer: probeBuffer,
        extHint: _extOf(name).slice(1),
        historyAbsPath,
      });
      if (kind === 'audio' && isAudioOverDurationLimit(dur)) {
        return { ..._durationSkipResult(tag, 'audio', dur), syncedPath: syncedPath || null };
      }
      if (kind === 'video' && isVideoOverDurationLimit(dur)) {
        return { ..._durationSkipResult(tag, 'video', dur), syncedPath: syncedPath || null };
      }
    } catch { /* continue to upload */ }
  }

  if (tagOnly) {
    return { tag, syncedPath: syncedPath || null, contentParts: [], textFragment: `${tag} ` };
  }

  const resolved = await _resolveIngressTarget(opts);
  if (resolved.error) {
    return { tag, syncedPath: syncedPath || null, contentParts: [], textFragment: `${tag} (${resolved.error}) ` };
  }

  const built = await buildXaiFileParts(resolved.absPath, resolved.displayName, {
    mimetype: resolved.mimetype,
    imagesReadCount: opts.imagesReadCount ?? 0,
  });
  if (!built.success) {
    log.warn(`xAI ingestion skipped for ${resolved.displayName}: ${built.error}`);
    const failTag = buildAttachmentTag(syncedPath, name);
    return { tag: failTag, syncedPath: syncedPath || null, contentParts: [], textFragment: `${failTag} (${built.error}) ` };
  }

  let finalSyncedPath = syncedPath;
  if (!finalSyncedPath && opts.historyStorageId && opts.platformAttachmentId) {
    try {
      const saved = await syncFileToHistory(
        opts.historyStorageId,
        opts.platformAttachmentId,
        async () => fs.readFileSync(resolved.absPath),
        resolved.displayName,
      );
      if (saved) finalSyncedPath = saved;
    } catch (err) {
      log.warn(`Post-upload history sync failed for ${resolved.displayName}: ${err.message}`);
    }
  }

  const finalTag = buildAttachmentTag(finalSyncedPath, name);
  const filePart = built.parts.find(p => p.type === 'input_file' || p.type === 'input_image');
  if (filePart) {
    if (finalSyncedPath && opts.historyStorageId) {
      const histAbs = resolveHistoryAbsPath(opts.historyStorageId, finalSyncedPath);
      if (histAbs) filePart._xaiSourcePath = histAbs;
    } else if (resolved.absPath) {
      filePart._xaiSourcePath = resolved.absPath;
    }
  }
  return {
    tag: finalTag,
    syncedPath: finalSyncedPath || null,
    contentParts: filePart ? [filePart] : [],
    textFragment: `${finalTag} `,
    bumpImageCount: built.bumpImageCount,
  };
}

// -- read_file delivery (history + build workspace/skills) ------------------------

/**
 * Unified read_file delivery (build sub-agent + history native attachment).
 * URL path: upload + native parts (input_file / input_image).
 * Build (inlineTextCode): text/code -> inline numbered content for edit_file.
 *
 * @returns {Promise<{ kind: 'parts', parts: object[], bumpImageCount?: boolean }
 *   | { kind: 'inline', content: string, truncated: boolean }
 *   | { kind: 'error', error: string }>}
 */
async function deliverReadFileFromPath({
  absPath,
  displayPath,
  contentType = '',
  imagesReadCount = 0,
  blockedMessage,
  /** Build sub-agent only: inline numbered text for edit_file. Main always URL. */
  inlineTextCode = false,
}) {
  const ext = _extOf(absPath);
  const mimetype = contentType || mimeForExtension(ext, 'application/octet-stream', contentType);

  if (isNonReadableExt(ext)) {
    return { kind: 'error', error: blockedMessage || mainReadFileBlockedMessage(ext) };
  }

  if (inlineTextCode && isTextualFile(path.basename(absPath), mimetype)) {
    const inline = readNumberedTextFromPath(absPath, displayPath);
    if (!inline.ok) return { kind: 'error', error: inline.error };
    return { kind: 'inline', content: inline.content, truncated: inline.truncated };
  }

  const mode = classifyAiFileDelivery(path.basename(absPath), mimetype);
  if (mode === DELIVERY_MODE.TAG_ONLY) {
    return { kind: 'error', error: `File type not supported for read_file: "${displayPath}".` };
  }

  const built = await buildXaiFileParts(absPath, displayPath, {
    mimetype,
    imagesReadCount,
  });
  if (!built.success) return { kind: 'error', error: built.error };
  return { kind: 'parts', parts: built.parts, bumpImageCount: built.bumpImageCount };
}

module.exports = {
  DELIVERY_MODE,
  XAI_IMAGE_EXTS,
  MAX_IMAGE_READS,
  MAX_FILE_READS,
  MAX_VIDEO_BYTES,
  classifyAiFileDelivery,
  buildXaiFileParts,
  exposeXaiUrlFromAbsPath,
  deliverReadFileFromPath,
  deliverSyncedAttachment,
  resolveHistoryAbsPath,
};
