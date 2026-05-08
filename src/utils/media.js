// src/utils/media.js
const { SUPPORTED_MEDIA } = require('../config/constants');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { OPENDATALOADER_HYBRID_URL, OPENDATALOADER_HYBRID_TIMEOUT } = require('../config/env');
const { createLogger } = require('./logger');

const log = createLogger('Media');

/**
 * Check if a media type is supported by the AI.
 * @param {string} type - Media type (e.g., 'image', 'audio')
 * @returns {boolean} True if media type is supported
 */
function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

function _replaceAttachmentPathInText(text, oldPath, newPath) {
  if (typeof text !== 'string' || !text) return text;
  const oldTagPath = String(oldPath || '').replace(/^history\//, '').trim();
  const newTagPath = String(newPath || '').replace(/^history\//, '').trim();
  if (!oldTagPath || !newTagPath || oldTagPath === newTagPath) return text;
  return text
    .split(`[Attachment: ${oldTagPath}]`).join(`[Attachment: ${newTagPath}]`)
    .split(`[Attachment (expired): ${oldTagPath}]`).join(`[Attachment (expired): ${newTagPath}]`);
}

/**
 * Convert media to base64 content part for the AI API (OpenAI-compatible format).
 * All media types use image_url with data URI — the MIME type tells the model the actual content type.
 * @param {Buffer} buffer
 * @param {string} mimetype - e.g. 'image/jpeg', 'audio/ogg', 'application/pdf'
 * @param {object} [opts]
 * @returns {object} Content part for the messages array
 */
function mediaToContentPart(buffer, mimetype, opts = {}) {
  // Strip parameters (e.g. 'audio/ogg; codecs=opus' → 'audio/ogg')
  const cleanMime = mimetype.split(';')[0].trim();
  const base64 = buffer.toString('base64');
  const part = {
    type: 'image_url',
    image_url: { url: `data:${cleanMime};base64,${base64}` },
  };
  if (opts && typeof opts.historyPath === 'string' && opts.historyPath.trim()) {
    part._historyPath = opts.historyPath.trim();
  }
  if (opts && typeof opts.historyUserId === 'string' && opts.historyUserId.trim()) {
    part._historyUserId = opts.historyUserId.trim();
  }
  return part;
}

/**
 * Extract text and images from a PDF buffer using Heavy/Hybrid AI mode.
 *
 * Heavy mode features:
 *  - OCR for scanned / non-extractable text
 *  - Complex table extraction (borderless, merged cells)
 *  - AI-generated picture descriptions (SmolVLM)
 *
 * The hybrid backend must be running at HYBRID_URL (default localhost:5002).
 * Falls back gracefully to Java-only extraction when the backend is down.
 *
 * @param {Buffer} buffer - raw PDF bytes
 * @param {object} [opts]
 * @param {string} [opts.persistDir] - if set, images are saved here permanently
 *                                     (used by syncFileToHistory for directory-based storage)
 * @returns {Promise<{success:boolean, text?:string, pages?:number, assetsDir?:string, error?:string}>}
 */
async function extractTextFromPdfBuffer(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { success: false, error: 'Invalid PDF buffer' };
  }

  const HYBRID_URL = OPENDATALOADER_HYBRID_URL;
  const HYBRID_TIMEOUT = OPENDATALOADER_HYBRID_TIMEOUT;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemix-pdf-'));
  const inputPdf = path.join(workDir, 'document.pdf');
  const outputDir = path.join(workDir, 'out');
  // If caller wants images persisted, use their dir; otherwise a temp subdir.
  const imageDir = opts.persistDir
    ? path.join(opts.persistDir, 'assets')
    : path.join(workDir, 'assets');

  try {
    await fs.writeFile(inputPdf, buffer);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(imageDir, { recursive: true });

    let convert;
    try {
      const mod = await import('@opendataloader/pdf');
      convert = mod.convert;
    } catch (err) {
      log.error(`❌ PDF parser dependency missing (@opendataloader/pdf): ${err.message}`);
      return { success: false, error: 'PDF transcription service is currently unavailable (missing dependency).' };
    }

    log.info(`📄 Transcribing PDF (${buffer.length} bytes)... Mode: ${HYBRID_URL ? 'Hybrid (Heavy)' : 'Local (Light)'}`);
    const start = Date.now();

    await convert([inputPdf], {
      outputDir,
      format: ['json', 'markdown-with-images'],
      hybrid: 'docling-fast',
      hybridMode: 'full',
      hybridUrl: HYBRID_URL,
      hybridTimeout: String(HYBRID_TIMEOUT),
      hybridFallback: true,

      // Image extraction
      imageOutput: 'external',
      imageDir,
      imageFormat: 'png',

      // Table & structure
      tableMethod: 'cluster',
      useStructTree: true,
      includeHeaderFooter: true,
      detectStrikethrough: true,
      sanitize: false,
      threads: '4',
      quiet: true,
      enrichTable: true,
    });

    log.info(`✅ PDF Transcription finished in ${((Date.now() - start) / 1000).toFixed(1)}s`);

    const baseName = path.basename(inputPdf, '.pdf');
    const markdownPath = path.join(outputDir, `${baseName}.md`);
    const jsonPath = path.join(outputDir, `${baseName}.json`);

    let text = '';
    if (await _fileExists(markdownPath)) {
      text = await fs.readFile(markdownPath, 'utf8');
    }

    let pages = 0;
    if (await _fileExists(jsonPath)) {
      const rawJson = await fs.readFile(jsonPath, 'utf8');
      const jsonData = JSON.parse(rawJson);
      pages = _pdfPageCountFromJson(jsonData);
      if (!text) {
        text = _textFromJson(jsonData);
      }
    }

    if (!text) {
      log.error('❌ PDF parser returned no text (markdown empty, JSON empty)');
      return { success: false, error: 'OpenDataLoader returned no text' };
    }

    // If images were persisted, rewrite image paths in markdown to use
    // relative `assets/` references (the markdown-with-images format may
    // use the absolute imageDir path).
    if (opts.persistDir) {
      const absPrefix = imageDir.replace(/\\/g, '/');
      text = text.split(absPrefix).join('assets');
    }

    // Determine if there are actual extracted images
    let hasAssets = false;
    try {
      const assetEntries = await fs.readdir(imageDir);
      hasAssets = assetEntries.length > 0;
    } catch { /* empty dir or missing — fine */ }

    return {
      success: true,
      text: text.trim(),
      pages,
      assetsDir: hasAssets ? imageDir : undefined,
    };
  } catch (err) {
    const msg = err?.message || String(err);
    log.error(`❌ PDF parsing failed: ${msg}`);
    return { success: false, error: msg };
  } finally {
    // Only clean up the temp workDir; if persistDir was used, the assets
    // directory lives outside workDir and must NOT be deleted.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function _fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function _pdfPageCountFromJson(jsonData) {
  if (!Array.isArray(jsonData)) return 0;
  return jsonData.reduce((max, item) => {
    const page = Number(item['page number'] ?? item.page ?? 0);
    return Number.isFinite(page) && page > max ? page : max;
  }, 0);
}

function _textFromJson(jsonData) {
  if (!Array.isArray(jsonData)) return '';
  return jsonData
    .map(item => {
      const parts = [];
      if (typeof item.title === 'string' && item.title) parts.push(item.title);
      if (typeof item.heading === 'string' && item.heading) parts.push(item.heading);
      if (typeof item.content === 'string' && item.content) parts.push(item.content);
      else if (typeof item.text === 'string' && item.text) parts.push(item.text);
      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build a filename descriptor for unsupported or any media in history
 */
function mediaTag(filename, mimetype) {
  if (filename) return `[${filename}]`;
  const ext = (mimetype || '').split('/')[1] || 'file';
  return `[file.${ext}]`;
}

/**
 * Pre-API-call hook: every PDF that is part of the round content (incoming
 * attachment, reply to a recent PDF, or any other source that sets a PDF
 * content part) is parsed in place into the canonical parsed-PDF folder
 * (history zone — meta pointers are updated so future history reads keep
 * working). The base64 PDF is then **replaced** with the resulting markdown
 * transcription so the AI never sees raw PDF bytes.
 *
 * Single parse, no fallback re-parsing: if `persistParsedPdfToHistory`
 * fails, an explicit error message is injected for the AI (it must call
 * `bug_report` and stop, NOT retry parsing in agentic mode).
 *
 * @param {Array|string} content - Message content (can be string or array of parts)
 * @param {object} [opts] - Options
 * @param {object} [opts.ctx] - Handler context for notifications
 * @param {function} [opts.onTranscriptionStart] - Callback when transcription starts (message)
 * @param {function} [opts.onTranscriptionEnd] - Callback when transcription ends
 * @returns {Promise<Array|string>} Transcribed content
 */
async function transcribeDocumentsInMessageContent(content, opts = {}) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const transcribed = [];
  const attachmentPathReplacements = new Map();
  const { ctx, onTranscriptionStart, onTranscriptionEnd } = opts;
  
  // Use tracker if context and callbacks are provided
  const useTracker = ctx && typeof onTranscriptionStart === 'function';
  let trackerData = null;
  
  if (useTracker) {
    const { incrementTranscription, buildNotificationMessage } = require('./pdfTranscriptionTracker');
    trackerData = incrementTranscription(ctx);
    if (trackerData.shouldNotify && onTranscriptionStart) {
      const message = buildNotificationMessage(trackerData.count);
      await onTranscriptionStart(message);
    }
  }

  try {
    for (const part of content) {
      if (!part) {
        transcribed.push(part);
        continue;
      }

      if (_getMediaTypeFromContentPart(part) !== 'document') {
        transcribed.push(part);
        continue;
      }

      const dataUrl = part.image_url?.url || '';
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!match || match[1].toLowerCase() !== 'application/pdf') {
        transcribed.push({
          type: 'text',
          text: `[PDF parsing skipped: unsupported document type "${match ? match[1] : 'unknown'}"]. Inform the user and call bug_report.`,
        });
        continue;
      }

      const historyPath = typeof part._historyPath === 'string' ? part._historyPath.trim() : null;
      const historyUserId = typeof part._historyUserId === 'string' ? part._historyUserId.trim() : null;

      if (!historyPath || !historyUserId) {
        // Defensive: every PDF reaching this point should originate from a
        // platform handler that always tags content parts with these fields.
        log.error(`❌ PDF content part missing history metadata — refusing to parse.`);
        transcribed.push({
          type: 'text',
          text: `[PDF parsing skipped: internal error — missing history metadata]. STOP. Do NOT retry in agentic mode. Use bug_report (source="pdf-parser") to notify the admin and tell the user there is a system error and to retry later.`,
        });
        continue;
      }

      const buffer = Buffer.from(match[2], 'base64');
      const { persistParsedPdfToHistory } = require('./historySync');
      const persisted = await persistParsedPdfToHistory(historyUserId, historyPath, buffer);

      if (persisted.success && typeof persisted.text === 'string' && persisted.text.trim()) {
        transcribed.push({
          type: 'text',
          text: `<Transcription>\n${persisted.text}\n</Transcription>`,
        });
        if (persisted.historyPath && persisted.historyPath !== historyPath) {
          attachmentPathReplacements.set(historyPath, persisted.historyPath);
        }
        continue;
      }

      const errorMsg = persisted.error || 'Unknown PDF parsing error';
      log.error(`❌ PDF round-pre-call parsing failed for ${historyPath}: ${errorMsg}`);
      transcribed.push({
        type: 'text',
        text: `[PDF parsing failed: ${errorMsg}]. STOP. Do NOT enter agentic mode to retry parsing yourself. Use bug_report (source="pdf-parser", details=brief) to notify the admin, then tell the user there is a system error and to retry later.`,
      });
    }

    if (attachmentPathReplacements.size > 0) {
      for (const part of transcribed) {
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
        for (const [oldPath, newPath] of attachmentPathReplacements.entries()) {
          part.text = _replaceAttachmentPathInText(part.text, oldPath, newPath);
        }
      }
    }

    return transcribed;
  } finally {
    // Decrement tracker count when done
    if (useTracker && ctx) {
      const { decrementTranscription } = require('./pdfTranscriptionTracker');
      decrementTranscription(ctx);
      if (onTranscriptionEnd) {
        await onTranscriptionEnd();
      }
    }
  }
}

function _getMediaTypeFromContentPart(part) {
  if (!part || !part.image_url || !part.image_url.url) return null;
  const m = /^data:([^;]+);base64,/.exec(part.image_url.url);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('application/')) return 'document';
  return null;
}

/**
 * Build a standardized attachment tag for AI context (always English).
 * @param {string|null} syncedPath - The synced history path (e.g. 'file.pdf'), or null if expired
 * @param {string|null} fallbackName - Fallback filename for expired attachments
 * @returns {string} Tag like '[Attachment: file.pdf]' or '[Attachment (expired): file.pdf]'
 */
function buildAttachmentTag(syncedPath, fallbackName) {
  if (syncedPath) {
    const clean = syncedPath.startsWith('history/') ? syncedPath.slice('history/'.length) : syncedPath;
    return `[Attachment: ${clean}]`;
  }
  return `[Attachment (expired): ${fallbackName || 'file'}]`;
}

function extractAttachmentTagPaths(text) {
  const paths = [];
  if (typeof text !== 'string' || text.length === 0) return paths;
  const re = /\[Attachment(?:\s*\(expired\))?:\s*([^\]\n\r]+)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (raw) paths.push(raw);
  }
  return paths;
}

module.exports = {
  isSupportedMedia,
  mediaToContentPart,
  mediaTag,
  extractTextFromPdfBuffer,
  transcribeDocumentsInMessageContent,
  buildAttachmentTag,
  extractAttachmentTagPaths,
};
