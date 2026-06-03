// Central policy for how files reach xAI: tunnel URL, inline <FileContent>, or tag-only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, MAX_IMAGE_BYTES } = require('../config/constants');
const { mimeForExtension } = require('../config/mimeExtensions');
const { isNonReadableExt, mainReadFileBlockedMessage } = require('../config/nonReadableExts');
const { getPublicAttachmentUrl, tempDirForOwner } = require('./tempFileServer');
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
  TUNNEL: 'tunnel',
  INLINE_TEXT: 'inline_text',
  TAG_ONLY: 'tag_only',
};

/** Max inline bytes on current-turn ingress (WA/Discord). */
const INGRESS_INLINE_TEXT_MAX_BYTES = 200 * 1024;
/** Max inline bytes when read_file loads text from disk. */
const READ_FILE_TEXT_MAX_BYTES = 50 * 1024;

/** Extensions tunneled to xAI (aligned with ingress MIME policy). */
const TUNNEL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.tiff', '.tif']);
const TUNNEL_AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac']);
const TUNNEL_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);

const MAX_IMAGE_READS = 10;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_PDF_BYTES = 48 * 1024 * 1024;

const INLINE_TEXT_EXTS = new Set([
  '.txt', '.md', '.rst', '.log', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sh', '.bash', '.zsh', '.bat', '.ps1', '.makefile', '.dockerfile',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyw', '.rb', '.php',
  '.java', '.kt', '.scala', '.groovy', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.jl',
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.sql', '.graphql', '.gql',
  '.patch', '.diff',
]);

const INLINE_TEXT_MIME_PREFIXES = ['text/'];
const INLINE_TEXT_MIME_EXTRA = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-shellscript',
]);

function isInlineableTextFile(filename, mimetype) {
  const mime = (mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime) {
    if (INLINE_TEXT_MIME_PREFIXES.some(p => mime.startsWith(p))) return true;
    if (INLINE_TEXT_MIME_EXTRA.has(mime)) return true;
  }
  if (typeof filename === 'string' && filename) {
    const idx = filename.lastIndexOf('.');
    if (idx >= 0) {
      const ext = filename.slice(idx).toLowerCase();
      if (INLINE_TEXT_EXTS.has(ext)) return true;
    }
  }
  return false;
}

function hasInlineFileContent(text) {
  return typeof text === 'string' && text.includes('<FileContent');
}

function hasIngressTextFragment(text) {
  return typeof text === 'string' && (text.includes('<FileContent') || text.includes('<Transcription>'));
}

/**
 * Build numbered <FileContent> XML from a buffer.
 * @param {string} displayPath - path attribute (history/... or /workspace/...)
 * @param {Buffer} buffer
 * @param {{ maxBytes?: number, sanitizePath?: boolean }} [opts]
 */
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

function buildInlineTextFilePart(displayPath, buffer, opts = {}) {
  const maxBytes = opts.maxBytes ?? INGRESS_INLINE_TEXT_MAX_BYTES;
  const sanitize = opts.sanitizePath !== false;
  let text = buffer.toString('utf-8');
  let truncated = false;
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    const cut = _truncateUtf8Text(text, maxBytes);
    text = cut.text;
    truncated = cut.truncated;
  }
  const lines = text.split(/\r?\n/);
  const numberedText = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
  const pathAttr = sanitize
    ? String(displayPath || 'file').replace(/[<>"'&]/g, '_')
    : String(displayPath || 'file');
  const truncAttr = truncated ? ' truncated="true"' : '';
  return `<FileContent path="${pathAttr}"${truncAttr}>\n${numberedText}\n</FileContent>`;
}

/**
 * Read a file from disk and return inline <FileContent> XML.
 * @returns {{ ok: true, content: string } | { ok: false, error: string }}
 */
function readInlineTextFromPath(absPath, displayPath, opts = {}) {
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
    const buffer = fs.readFileSync(absPath);
    return {
      ok: true,
      content: buildInlineTextFilePart(displayPath, buffer, { maxBytes, sanitizePath: false }),
    };
  } catch (err) {
    return { ok: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }
}

function tunnelKindForExtension(ext, contentType = '') {
  const e = (ext || '').toLowerCase();
  const key = e.startsWith('.') ? e : (e ? `.${e}` : '');
  if (key === '.pdf') return 'pdf';
  if (key === '.webm') {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();
    if (ct === 'audio/webm' || (ct.startsWith('audio/') && !ct.startsWith('video/'))) return 'audio';
    return 'video';
  }
  if (TUNNEL_IMAGE_EXTS.has(key)) return 'image';
  if (TUNNEL_AUDIO_EXTS.has(key)) return 'audio';
  if (TUNNEL_VIDEO_EXTS.has(key)) return 'video';
  return null;
}

function _tunnelKindFromMime(contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  return null;
}

function classifyAiFileDelivery(name, contentType) {
  const ext = path.extname(name || '').toLowerCase();
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (isNonReadableExt(ext)) return DELIVERY_MODE.TAG_ONLY;
  if (tunnelKindForExtension(ext, contentType)) return DELIVERY_MODE.TUNNEL;
  if (isInlineableTextFile(name, contentType)) return DELIVERY_MODE.INLINE_TEXT;

  if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/')) {
    return DELIVERY_MODE.TUNNEL;
  }
  if (ct === 'application/pdf' || ext === '.pdf') return DELIVERY_MODE.TUNNEL;

  return DELIVERY_MODE.TAG_ONLY;
}

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

async function validateTunnelMediaFile(absPath, displayPath, opts = {}) {
  const ext = path.extname(absPath).toLowerCase();
  const contentType = opts.contentType || opts.mimetype || '';
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (err) {
    return { ok: false, error: `Cannot read file "${displayPath}": ${err.message}` };
  }

  const fileSize = stat.size;
  let kind = tunnelKindForExtension(ext, contentType) || _tunnelKindFromMime(contentType);

  if (kind === 'image') {
    const count = opts.imagesReadCount ?? 0;
    if (count >= MAX_IMAGE_READS) {
      return { ok: false, error: `Image limit reached. You can only read up to ${MAX_IMAGE_READS} images per call.` };
    }
    if (fileSize === 0) return { ok: false, error: `Image file "${displayPath}" is empty.` };
    if (fileSize > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image "${displayPath}" exceeds the size limit (${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).` };
    }
    return { ok: true, bumpImageCount: true };
  }

  if (kind === 'pdf') {
    if (fileSize > MAX_PDF_BYTES) {
      return { ok: false, error: `PDF "${displayPath}" exceeds the 48 MB xAI limit.` };
    }
    return { ok: true };
  }

  if (kind === 'audio') {
    if (fileSize > MAX_AUDIO_BYTES) {
      return { ok: false, error: `Audio file exceeds size limit (${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB max).` };
    }
    const audioDur = await getMediaDurationSec(fs.readFileSync(absPath), ext.slice(1) || 'ogg');
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
    const videoDur = await getMediaDurationSec(fs.readFileSync(absPath), ext.slice(1) || 'mp4');
    if (isVideoOverDurationLimit(videoDur)) {
      return {
        ok: false,
        error: `Video exceeds the duration limit (${Math.round(videoDur)}s). Tell the user the clip is too long for native playback in chat.`,
      };
    }
    return { ok: true };
  }

  return { ok: false, error: `File type not supported for tunnel delivery: "${displayPath}".` };
}

async function appendTunnelInputFile(contentParts, opts) {
  const {
    syncedPath,
    name,
    contentType = '',
    historyStorageId,
    fetchBuffer,
    ownerKey = null,
  } = opts;

  if (classifyAiFileDelivery(name, contentType) !== DELIVERY_MODE.TUNNEL) {
    return { ok: false, skipped: true };
  }

  const ext = path.extname(name || '').toLowerCase();
  const mimetype = mimeForExtension(
    ext,
    (contentType || '').split(';')[0].trim() || 'application/octet-stream',
    contentType,
  );
  const displayName = path.basename(syncedPath || name || 'file');

  let absPath = syncedPath && historyStorageId
    ? resolveHistoryAbsPath(historyStorageId, syncedPath)
    : null;
  let kind = 'history';

  if (!absPath) {
    const buffer = typeof fetchBuffer === 'function' ? await fetchBuffer() : null;
    if (!buffer || !buffer.length) {
      return { ok: false, error: 'file unavailable' };
    }
    try {
      absPath = _materializeBufferToTemp(buffer, displayName, ownerKey);
      kind = 'temp';
    } catch (err) {
      log.warn(`Failed to materialize ${displayName}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  const gate = await validateTunnelMediaFile(absPath, displayName, { ...opts, contentType: mimetype });
  if (!gate.ok) {
    log.warn(`Tunnel validation failed for ${displayName}: ${gate.error}`);
    return { ok: false, error: gate.error };
  }

  try {
    const urlInfo = getPublicAttachmentUrl(absPath, displayName, { kind, mimetype });
    contentParts.push({ type: 'input_file', file_url: urlInfo.url });
    return { ok: true, bumpImageCount: gate.bumpImageCount };
  } catch (err) {
    log.warn(`Tunnel registration failed for ${displayName}: ${err.message}`);
    return { ok: false, error: `Cannot expose "${displayName}" via attachment tunnel: ${err.message}` };
  }
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

async function deliverSyncedAttachment(opts) {
  const {
    syncedPath,
    name,
    contentType = '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec = 0,
    getVoiceTranscription = null,
    ownerKey = null,
  } = opts;

  const tag = buildAttachmentTag(syncedPath, name);
  const mode = classifyAiFileDelivery(name, contentType);
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();

  if (mode === DELIVERY_MODE.TAG_ONLY) {
    return { tag, contentParts: [], textFragment: `${tag} ` };
  }

  if (mode === DELIVERY_MODE.INLINE_TEXT) {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        const inline = buildInlineTextFilePart(syncedPath || name, buffer, {
          maxBytes: INGRESS_INLINE_TEXT_MAX_BYTES,
          sanitizePath: true,
        });
        return { tag, contentParts: [], textFragment: `${inline} ` };
      }
    } catch { /* tag only */ }
    return { tag, contentParts: [], textFragment: `${tag} ` };
  }

  const tunnelKind = tunnelKindForExtension(path.extname(name || ''), contentType);
  if ((ct.startsWith('audio/') || tunnelKind === 'audio') && typeof getVoiceTranscription === 'function') {
    const tx = await getVoiceTranscription();
    if (tx) {
      return {
        tag,
        contentParts: [],
        textFragment: `${tag} <Transcription>${tx}</Transcription> `,
      };
    }
  }

  if (ct.startsWith('audio/') || tunnelKind === 'audio') {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        const audioDuration = await resolveMediaDurationSec({
          metadataSec: metadataDurationSec,
          buffer,
          extHint: path.extname(name || '').slice(1),
        });
        if (isAudioOverDurationLimit(audioDuration)) {
          return _durationSkipResult(tag, 'audio', audioDuration);
        }
      }
    } catch { /* continue to tunnel */ }
  }

  if (ct.startsWith('video/') || tunnelKind === 'video') {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        const dur = await resolveMediaDurationSec({
          metadataSec: metadataDurationSec,
          buffer,
          extHint: path.extname(name || '').slice(1),
        });
        if (isVideoOverDurationLimit(dur)) {
          return _durationSkipResult(tag, 'video', dur);
        }
      }
    } catch { /* continue to tunnel */ }
  }

  const contentParts = [];
  const tunnel = await appendTunnelInputFile(contentParts, {
    syncedPath,
    name,
    contentType,
    historyStorageId,
    fetchBuffer,
    ownerKey,
  });

  let textFragment = `${tag} `;
  if (!tunnel.ok && !tunnel.skipped && tunnel.error) {
    textFragment = `${tag} (${tunnel.error}) `;
  }
  return { tag, contentParts, textFragment };
}

/**
 * Register an on-disk file on the attachment tunnel (build round-1, imagine refs).
 * @returns {Promise<{ success: true, url: string, parts: object[], bumpImageCount?: boolean } | { success: false, error: string }>}
 */
async function exposeTunnelFromAbsPath(absPath, displayPath, opts = {}) {
  const ext = path.extname(absPath).toLowerCase();
  const mimetype = opts.mimetype || opts.contentType || mimeForExtension(ext, 'application/octet-stream', opts.contentType);
  const tunnel = await buildTunnelAttachmentParts(
    absPath,
    displayPath,
    mimetype,
    opts.kind || 'history',
    { ...opts, contentType: mimetype },
  );
  if (!tunnel.success) return tunnel;
  const filePart = tunnel.parts.find(p => p && p.type === 'input_file');
  return {
    success: true,
    url: filePart && filePart.file_url,
    parts: tunnel.parts,
    bumpImageCount: tunnel.bumpImageCount,
  };
}

async function buildTunnelAttachmentParts(absPath, displayPath, mimetype, kind = 'history', opts = {}) {
  const gate = await validateTunnelMediaFile(absPath, displayPath, { ...opts, contentType: mimetype });
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  try {
    const urlInfo = getPublicAttachmentUrl(absPath, path.basename(absPath), { kind, mimetype });
    const parts = [
      { type: 'text', text: `[Attachment: ${displayPath}]` },
      { type: 'input_file', file_url: urlInfo.url },
    ];
    return { success: true, parts, bumpImageCount: gate.bumpImageCount };
  } catch (err) {
    log.warn(`Failed to expose ${displayPath} via tunnel: ${err.message}`);
    return { success: false, error: `Cannot expose "${displayPath}" via attachment tunnel: ${err.message}` };
  }
}

/**
 * Unified read_file delivery (history + build workspace/skills).
 * @returns {Promise<{ kind: 'tunnel', parts: object[], bumpImageCount?: boolean } | { kind: 'inline', content: string } | { kind: 'error', error: string }>}
 */
async function deliverReadFileFromPath({
  absPath,
  displayPath,
  contentType = '',
  imagesReadCount = 0,
  blockedMessage,
  tunnelStorageKind = 'history',
}) {
  const ext = path.extname(absPath).toLowerCase();
  const mimetype = contentType || mimeForExtension(ext, 'application/octet-stream', contentType);
  const mode = classifyAiFileDelivery(path.basename(absPath), mimetype);

  if (mode === DELIVERY_MODE.TUNNEL) {
    const tunnel = await buildTunnelAttachmentParts(absPath, displayPath, mimetype, tunnelStorageKind, {
      imagesReadCount,
      contentType: mimetype,
    });
    if (!tunnel.success) return { kind: 'error', error: tunnel.error };
    return { kind: 'tunnel', parts: tunnel.parts, bumpImageCount: tunnel.bumpImageCount };
  }

  if (mode === DELIVERY_MODE.INLINE_TEXT) {
    const inline = readInlineTextFromPath(absPath, displayPath, { maxBytes: READ_FILE_TEXT_MAX_BYTES });
    if (!inline.ok) return { kind: 'error', error: inline.error };
    return { kind: 'inline', content: inline.content };
  }

  if (isNonReadableExt(ext)) {
    return { kind: 'error', error: blockedMessage || mainReadFileBlockedMessage(ext, 'whatsapp') };
  }
  return { kind: 'error', error: `File type not supported for read_file: "${displayPath}".` };
}

module.exports = {
  DELIVERY_MODE,
  TUNNEL_IMAGE_EXTS,
  classifyAiFileDelivery,
  hasInlineFileContent,
  hasIngressTextFragment,
  deliverReadFileFromPath,
  deliverSyncedAttachment,
  exposeTunnelFromAbsPath,
};