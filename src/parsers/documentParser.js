// src/parsers/documentParser.js
//
// Documents, spreadsheets, slides, email and archives — everything Kreuzberg
// reads.
//
// One dependency does the work: text, tables, embedded images, metadata and
// OCR all come out of the same call, so there is no per-format branch here to
// keep in sync with ~90 formats. What this module adds is the part Kreuzberg
// cannot decide: when the extracted text is too thin to be the real content —
// a scanned report, a slide deck that is mostly diagrams — the pages are also
// rendered and attached as images, because the model's vision reads a rendered
// page better than any table-to-text heuristic does.
//
// Kreuzberg's binding is loaded lazily. It is a native module; a deployment
// that has not installed it yet must still be able to read a text file.

import path from 'path';
import { spawn } from 'child_process';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { mimeForExtension } from '../config/mimeExtensions.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DocumentParser');

/** What Kreuzberg is asked to read. Extensions, because that is what a path has. */
const DOCUMENT_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.odt', '.rtf', '.xlsx', '.xls', '.ods', '.csv', '.tsv',
  '.pptx', '.ppt', '.odp', '.epub', '.eml', '.msg', '.html', '.htm', '.xml'
]);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);

/**
 * Below this many characters per page, a PDF is treated as one the text layer
 * does not really describe: a scan, or pages that are mostly figures. Rendering
 * costs a few images; getting it wrong the other way costs the whole content.
 */
const THIN_TEXT_CHARS_PER_PAGE = 200;

let _kreuzberg = null;
let _kreuzbergError = null;
let _ocrAvailable = null;
let _ocrProbe = null;

function _abortReason(signal) {
  return signal?.reason || new Error('Document parsing aborted.');
}

function _abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(_abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(_abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Load the native binding once, remembering a failure so it is not retried per read. */
async function _load() {
  if (_kreuzberg) return _kreuzberg;
  if (_kreuzbergError) return null;
  try {
    _kreuzberg = await import('@kreuzberg/node');
    return _kreuzberg;
  } catch (err) {
    _kreuzbergError = err;
    log.warn(`Document parsing is unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Whether this host can OCR at all.
 *
 * Kreuzberg drives the system tesseract, which is a host package, not something
 * npm installs. Probing once and turning OCR off when it is missing is what
 * keeps a scanned PDF returning its (empty) text layer with an honest note,
 * instead of every document read spilling tesseract errors.
 */
async function ocrAvailable() {
  if (_ocrAvailable !== null) return _ocrAvailable;
  if (!_ocrProbe) {
    _ocrProbe = new Promise((resolve) => {
      let settled = false;
      const finish = (available) => {
        if (settled) return;
        settled = true;
        _ocrAvailable = available;
        if (!available) log.info('tesseract not found: scanned pages will not be OCR-ed');
        resolve(available);
      };
      let child;
      try { child = spawn(envConfig.TESSERACT_PATH, ['--version'], { stdio: 'ignore' }); }
      catch { finish(false); return; }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish(false);
      }, 5000);
      timer.unref?.();
      child.once('error', () => { clearTimeout(timer); finish(false); });
      child.once('exit', code => { clearTimeout(timer); finish(code === 0); });
    });
  }
  return _ocrProbe;
}

/** True when this module claims the file. */
function handlesExt(ext) {
  return DOCUMENT_EXTS.has(ext) || ARCHIVE_EXTS.has(ext);
}

function _isPdf(ext) {
  return ext === '.pdf';
}

/** Metadata worth showing, without the internals of whichever parser ran. */
function _cleanMetadata(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const keep = [
    'title', 'author', 'subject', 'createdAt', 'modifiedAt', 'createdBy', 'producer',
    'pageCount', 'wordCount', 'languages', 'width', 'height', 'isEncrypted', 'pdfVersion'
  ];
  const out = {};
  for (const k of keep) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Render the first pages of a PDF so vision can read what the text layer lost. */
async function _renderPages(kreuzberg, absPath, pageCount, notes, signal) {
  const pages = Math.min(pageCount || 1, constants.PARSE_MAX_PDF_RENDER_PAGES);
  const images = [];
  // The renderer indexes from 0; everything the model sees counts from 1.
  for (let index = 0; index < pages; index++) {
    if (signal?.aborted) throw _abortReason(signal);
    try {
      const png = await _abortable(kreuzberg.renderPdfPage(absPath, index, { scale: 2 }), signal);
      const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png);
      if (buffer.length > 0) images.push({ page: index + 1, buffer, mime: 'image/png' });
    } catch (err) {
      notes.push(`Page ${index + 1} could not be rendered: ${err.message}`);
      break;
    }
  }
  if (pageCount > pages) {
    notes.push(`Rendered the first ${pages} of ${pageCount} pages; slice the rest with shell if you need them.`);
  }
  return images;
}

/** Embedded images (figures, charts, photos) the document carries. */
function _embeddedImages(result, notes) {
  const raw = Array.isArray(result.images) ? result.images : [];
  if (raw.length === 0) return [];
  const out = [];
  for (const img of raw.slice(0, constants.PARSE_MAX_EMBEDDED_IMAGES)) {
    const data = img?.data ?? img?.bytes ?? img?.buffer;
    if (!data) continue;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length === 0) continue;
    out.push({ buffer, mime: img.mimeType || img.format || 'image/png', label: img.name || null });
  }
  if (raw.length > out.length) {
    notes.push(`${raw.length} images are embedded; the first ${out.length} are attached.`);
  }
  return out;
}

/** Tables as the model can actually use them: a compact markdown-ish shape. */
function _tables(result) {
  const raw = Array.isArray(result.tables) ? result.tables : [];
  return raw.length > 0 ? raw.length : 0;
}

/**
 * Parse one document or archive.
 *
 * @param {string} absPath
 * @param {object} [opts]
 * @param {string} [opts.ext] - lowercase extension, defaults to the path's
 * @param {boolean} [opts.ocr] - run OCR on pages with no text layer
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   ok: boolean, error?: string, kind?: string, content?: string,
 *   metadata?: object, images?: Array, notes?: string[]
 * }>}
 */
async function parseDocument(absPath, opts = {}) {
  const kreuzberg = await _abortable(_load(), opts.signal);
  if (!kreuzberg) {
    return { ok: false, error: 'The document parser is not installed on this deployment.' };
  }

  const ext = opts.ext || path.extname(absPath).toLowerCase();
  const notes = [];
  const useOcr = opts.ocr !== false && await _abortable(ocrAvailable(), opts.signal);
  let result;
  try {
    result = await _abortable(kreuzberg.extractFile(
      absPath,
      mimeForExtension(ext) || undefined,
      useOcr ? { ocr: { backend: 'tesseract' } } : {}
    ), opts.signal);
  } catch (err) {
    if (opts.signal?.aborted) throw _abortReason(opts.signal);
    return { ok: false, error: `Could not parse this file: ${err.message}` };
  }

  const metadata = _cleanMetadata(result.metadata);
  let content = typeof result.content === 'string' ? result.content : '';
  if (content.length > constants.PARSE_MAX_TEXT_CHARS) {
    content = content.slice(0, constants.PARSE_MAX_TEXT_CHARS);
    notes.push(`Text clipped at ${Math.round(constants.PARSE_MAX_TEXT_CHARS / 1000)}k characters.`);
  }

  const tableCount = _tables(result);
  if (tableCount > 0) notes.push(`${tableCount} table(s) detected; their cells are inline in the text above.`);

  const images = _embeddedImages(result, notes);

  // A PDF whose text is too thin for its page count is a scan or a deck: the
  // rendered pages are the content, not a nicety.
  if (_isPdf(ext)) {
    const pageCount = Number(metadata.pageCount) || 0;
    const thin = pageCount > 0 && content.trim().length < pageCount * THIN_TEXT_CHARS_PER_PAGE;
    if (thin) {
      notes.push('The text layer is thin for this page count, so the pages are attached as images.');
      if (!useOcr) notes.push('OCR is not available on this host, so scanned text is only in those images.');
      images.push(...await _renderPages(kreuzberg, absPath, pageCount, notes, opts.signal));
    }
  }

  return {
    ok: true,
    kind: ARCHIVE_EXTS.has(ext) ? 'archive' : 'document',
    content,
    metadata,
    images,
    notes
  };
}

export {
  handlesExt,
  ocrAvailable,
  parseDocument
};
