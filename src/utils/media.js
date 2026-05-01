// src/utils/media.js
const { SUPPORTED_MEDIA, MAX_DOC_PAGES } = require('../config/constants');
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

/**
 * Extract text transcription from a PDF document content part (base64).
 * Used to convert binary PDFs to text before sending to AI provider.
 * @param {object} contentPart - Content part with type='image_url' containing PDF base64
 * @returns {Promise<{success: boolean, text?: string, error?: string}>} Transcription result
 */
async function transcribeDocumentFromContentPart(contentPart) {
  try {
    if (!contentPart || !contentPart.image_url || !contentPart.image_url.url) {
      return { success: false, error: 'Invalid content part structure' };
    }

    const dataUrl = contentPart.image_url.url;
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      return { success: false, error: 'Invalid base64 data URI format' };
    }

    const mimetype = match[1].toLowerCase();
    const base64Data = match[2];

    // Only transcribe PDFs for now
    if (mimetype !== 'application/pdf') {
      return { success: false, error: `Unsupported document type: ${mimetype}` };
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const info = await extractTextFromPdfBuffer(buffer);

    if (!info || !info.success || !info.text) {
      return { success: false, error: info?.error || 'OpenDataLoader returned invalid text' };
    }

    if (info.pages > MAX_DOC_PAGES) {
      return {
        success: true,
        text: `[Document too long to process: ${info.pages} pages (max ${MAX_DOC_PAGES})]`,
      };
    }

    return {
      success: true,
      text: info.text,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

    try {
      const mod = await import('@opendataloader/pdf');
      convert = mod.convert;
    } catch (err) {
      log.error(`@opendataloader/pdf not found. Make sure it is installed: ${err.message}`);
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
      enrichPictureDescription: true,
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

      if (text) {
        // Inject AI descriptions from JSON into the Markdown text
        text = _injectDescriptionsIntoMarkdown(text, jsonData);
      } else {
        // Fallback: build text from JSON
        text = _textFromJson(jsonData);
      }
    }

    if (!text) {
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
    return { success: false, error: err?.message || String(err) };
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
    const page = Number(item['page number'] ?? item.page ?? (item.prov && item.prov[0]?.page_no) ?? 0);
    return Number.isFinite(page) && page > max ? page : max;
  }, 0);
}

function _textFromJson(jsonData) {
  if (!Array.isArray(jsonData)) return '';
  return jsonData
    .map(item => {
      const parts = [];
      if (typeof item.title === 'string' && item.title) parts.push(`### ${item.title}`);
      if (typeof item.heading === 'string' && item.heading) parts.push(`## ${item.heading}`);

      if (typeof item.content === 'string' && item.content) {
        parts.push(item.content);
      } else if (typeof item.text === 'string' && item.text) {
        parts.push(item.text);
      }

      // Include AI descriptions if present in JSON
      if (item.type === 'picture' || item.type === 'figure') {
        if (item.description) {
          parts.push(`\n> **AI Image Description**: ${item.description}\n`);
        }
      }

      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Injects AI-generated descriptions from JSON into the Markdown text.
 * Docling Markdown usually contains tags like ![image 1](path).
 * We find the corresponding JSON entry and append the description.
 */
function _injectDescriptionsIntoMarkdown(text, jsonData) {
  if (!Array.isArray(jsonData) || !text) return text;

  // Extract all pictures with descriptions from JSON
  const pictures = jsonData.filter(item => (item.type === 'picture' || item.type === 'figure') && item.description);
  if (pictures.length === 0) return text;

  let enrichedText = text;

  // Docling 2.x images in MD are usually numbered based on their order in the doc.
  // We'll try to match them. Note: index in MD might not perfectly align with JSON index
  // but usually they follow the document flow.
  pictures.forEach((pic, index) => {
    const aiDesc = pic.description;
    if (!aiDesc) return;

    // Look for various possible image tags: ![image N], ![picture N], or generic ![image]
    // We try to match ![image {index+1}] which is common.
    const imageTagRegex = new RegExp(`(!\\[(?:image|picture)\\s*${index + 1}?\\s*\\]\\([^)]+\\))`, 'g');

    if (imageTagRegex.test(enrichedText)) {
      enrichedText = enrichedText.replace(imageTagRegex, `$1\n\n> **AI Image Description**: ${aiDesc}\n`);
    } else {
      // Fallback: if we can't find the specific numbered tag, we might want to append
      // descriptions at the end or try a more generic match, but for now we only
      // inject if we find a likely match to avoid corrupting the layout.
    }
  });

  return enrichedText;
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
 * Transcribe all documents in a message content array.
 * Replaces PDF content parts with text transcriptions.
 * Used to ensure documents are always transcribed before sending to AI.
 * **IMPORTANT**: If transcription fails, removes the PDF entirely and replaces with error text.
 * PDFs are NEVER sent to the AI provider - either as text or not at all.
 * @param {Array|string} content - Message content (can be string or array of parts)
 * @returns {Promise<Array|string>} Transcribed content
 */
async function transcribeDocumentsInMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const transcribed = [];

  for (const part of content) {
    if (!part) {
      transcribed.push(part);
      continue;
    }

    // Check if this is a document content part
    if (_getMediaTypeFromContentPart(part) === 'document') {
      const result = await transcribeDocumentFromContentPart(part);
      if (result.success && result.text) {
        // Replace document with text containing transcription
        transcribed.push({
          type: 'text',
          text: `<Transcription>\n${result.text}\n</Transcription>`,
        });
      } else {
        // If transcription fails, DO NOT keep the PDF (it causes "image format illegal" errors).
        // Replace with error message instead.
        const errorMsg = result.error || 'Unknown error in document transcription';
        transcribed.push({
          type: 'text',
          text: `Document not transcribed (${errorMsg}). The file cannot be processed by the AI model.`,
        });
      }
    } else {
      // Keep non-document parts as-is
      transcribed.push(part);
    }
  }

  return transcribed;
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
 * @param {string|null} syncedPath - The synced history path (e.g. 'history/file.pdf'), or null if expired
 * @param {string|null} fallbackName - Fallback filename for expired attachments
 * @returns {string} Tag like '[Attachment: history/file.pdf]' or '[Attachment (expired): file.pdf]'
 */
function buildAttachmentTag(syncedPath, fallbackName) {
  if (syncedPath) return `[Attachment: ${syncedPath}]`;
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
  transcribeDocumentFromContentPart,
  transcribeDocumentsInMessageContent,
  buildAttachmentTag,
  extractAttachmentTagPaths,
};
