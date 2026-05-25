// src/utils/media.js
//
// Helpers for building/inspecting multimodal content parts that flow into
// the LLM call.
//
// Note (post-cleanup):
//   - The legacy in-bot PDF parser microservice (port 5002) and its
//     pre-pass `transcribeDocumentsInMessageContent` are gone. xAI's
//     /v1/responses endpoint ingests PDFs natively via `input_file` URLs,
//     so we hand the file off through the public attachment tunnel
//     (see `inputFileBuilder.js`) and let the model do the OCR/extraction.
//   - Same story for audio (was xAI STT) and video (was Gemini describer):
//     no more pre-pass, xAI handles them server-side.
//   - This file is now strictly about packaging buffers as inline content
//     parts for the user message and producing the small bookkeeping tags
//     used in chat history.

const { SUPPORTED_MEDIA } = require('../config/constants');

/**
 * Check if a media type is supported by the AI.
 * @param {string} type - Media type (e.g., 'image', 'audio')
 * @returns {boolean} True if media type is supported
 */
function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

/**
 * Convert media to a base64 content part for the user message.
 *
 * The shape is intentionally `image_url` + data URI for every MIME — that's
 * the legacy carrier used across the codebase. The `inputFileBuilder` runs
 * after history assembly and converts non-image MIMEs into proper xAI
 * `input_file` URL parts. Images stay base64 inline (the Responses adapter
 * translates them into native `input_image` parts).
 *
 * The optional `_historyPath` / `_historyUserId` metadata hints let
 * `inputFileBuilder` find the same file already on disk in chat history
 * and serve it via the longer 24h TTL token instead of materialising the
 * base64 buffer to a temp file again.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype - e.g. 'image/jpeg', 'audio/ogg', 'application/pdf'
 * @param {object} [opts]
 * @returns {object} Content part for the messages array
 */
function mediaToContentPart(buffer, mimetype, opts = {}) {
  // Strip parameters (e.g. 'audio/ogg; codecs=opus' → 'audio/ogg')
  const cleanMime = (mimetype || '').split(';')[0].trim();
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
 * Build a filename descriptor for unsupported or any media in history
 */
function mediaTag(filename, mimetype) {
  if (filename) return `[${filename}]`;
  const ext = (mimetype || '').split('/')[1] || 'file';
  return `[file.${ext}]`;
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

// ── Inline text-file ingestion ──────────────────────────────────────────────
//
// Source-code and plain-text files are not multimodal: feeding them as
// base64 inside an image_url part is wasteful and unreliable. Instead we
// inline the file content directly inside the user message text, wrapped
// in a small XML envelope so the model can clearly distinguish
// per-attachment content from the user's own typing.
//
// This applies ONLY to the message that triggers the current AI call
// (current Discord/WhatsApp message). In chat history the same files are
// referenced via [Attachment: filename] tags — the model can request the
// content via read_file when needed.
const INLINE_TEXT_EXTS = new Set([
  // Plain text / docs
  '.txt', '.md', '.rst', '.log', '.csv', '.tsv',
  // Web / config
  '.html', '.htm', '.xml', '.svg', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  // Shell / build
  '.sh', '.bash', '.zsh', '.bat', '.ps1', '.makefile', '.dockerfile',
  // Languages
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyw', '.rb', '.php',
  '.java', '.kt', '.scala', '.groovy', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.jl',
  // Web-frontend
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  // Data / queries
  '.sql', '.graphql', '.gql',
  // Patches / diffs
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

const INLINE_TEXT_MAX_BYTES = 200 * 1024; // 200 KB cap per file

/**
 * Decide whether a (filename, mimetype) pair is an inline-able text file.
 * Returns false for binary docs (pdf, docx, xlsx, zip, …) and unknown types.
 */
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

/**
 * Build an XML-tagged text part to inline a text-file body inside the user
 * message content. Mirrors the exact format produced by the read_file tool:
 *
 *   <FileContent path="..." size="N" [truncated="true"]>
 *   1: line1
 *   2: line2
 *   ...
 *   </FileContent>
 *
 * Keeping the format consistent means the model treats inlined attachments
 * and read_file outputs the same way (line refs, citations, edit prompts).
 *
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {string}
 */
function buildInlineTextFilePart(filename, buffer) {
  const totalSize = buffer.length;
  let text = buffer.toString('utf-8');
  let truncated = false;
  if (Buffer.byteLength(text, 'utf-8') > INLINE_TEXT_MAX_BYTES) {
    text = Buffer.from(text, 'utf-8').slice(0, INLINE_TEXT_MAX_BYTES).toString('utf-8') + '\n... (file truncated)';
    truncated = true;
  }
  const lines = text.split(/\r?\n/);
  const numberedText = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
  const safePath = String(filename || 'file').replace(/[<>"'&]/g, '_');
  const truncAttr = truncated ? ' truncated="true"' : '';
  return `<FileContent path="${safePath}" size="${totalSize}"${truncAttr}>\n${numberedText}\n</FileContent>`;
}

module.exports = {
  isSupportedMedia,
  mediaToContentPart,
  mediaTag,
  buildAttachmentTag,
  extractAttachmentTagPaths,
  isInlineableTextFile,
  buildInlineTextFilePart,
};
