// src/utils/pdfStructure.js
//
// Canonical "parsed PDF" folder layout used everywhere in the codebase

//
//   <basename>/
//     ├── <basename>.pdf       ← original PDF (moved inside, never deleted)
//     ├── transcription.md     ← markdown transcription with a paths/rules header
//     └── assets/              ← extracted images (optional)
//
// The transcription.md ALWAYS starts with a fenced header that lists the
// canonical (AI-visible) paths of every artefact and tells the AI:
//   - not to modify anything inside the folder,
//   - to copy the file it actually needs to a working dir (e.g. /workspace/temp/) first,
//   - that read_file on the original .pdf path will keep returning this same .md
//     (since the model cannot natively view PDFs).
//
// `buildParsedPdfStructure` is the single place where the structure is
// materialised. Both `historySync.persistParsedPdfToHistory` (history zone,
// with extra meta bookkeeping) and the generic non-history `readFile` flow
// delegate to it.

const fs = require('fs');
const path = require('path');
const { MAX_DOC_PAGES } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('PdfStructure');

const HEADER_BEGIN = '<!-- ===== GEMIX_PDF_PARSER_HEADER:BEGIN ===== -->';
const HEADER_END   = '<!-- ===== GEMIX_PDF_PARSER_HEADER:END ===== -->';

function _normVirtual(p) {
  return String(p || '').replace(/\\/g, '/').trim();
}

function _toToolAbsolutePath(p) {
  const clean = _normVirtual(p);
  if (!clean) return '';
  if (clean.startsWith('/workspace/') || clean === '/workspace') return clean;
  if (clean.startsWith('/readonly/') || clean === '/readonly') return clean;
  if (clean.startsWith('history/')) return `/readonly/${clean}`;
  if (clean.startsWith('searched_images/')) return `/readonly/${clean}`;
  if (clean.startsWith('skills/')) return `/readonly/${clean}`;
  return clean.startsWith('/') ? clean : `/${clean}`;
}

/**
 * Render the canonical paths/rules block prepended to every transcription.md.
 * Paths must be the AI-visible (virtual) ones — same form the AI passes to read_file.
 */
function buildPdfHeader({
  virtualDir,
  virtualPdf,
  virtualMd,
  virtualAssets,
  assetCount,
}) {
  const dir = _toToolAbsolutePath(virtualDir).replace(/\/+$/, '');
  const pdf = _toToolAbsolutePath(virtualPdf);
  const md  = _toToolAbsolutePath(virtualMd);
  const ast = _toToolAbsolutePath(virtualAssets).replace(/\/+$/, '');
  const assetsLine = assetCount > 0
    ? `${ast}/  (${assetCount} file${assetCount === 1 ? '' : 's'})`
    : `${ast}/  (empty)`;

  return [
    HEADER_BEGIN,
    '<!--',
    '  PDF PARSER STRUCTURE — DO NOT MODIFY',
    '',
    '  This PDF was parsed into a self-contained folder.',
    '  The paths below are canonical and managed by the tool. Treat them as',
    '  read-only inputs.',
    '',
    '  Absolute tool paths to use with read_file / copy operations:',
    `    Folder:    ${dir}/`,
    `    Original:  ${pdf}`,
    `    Markdown:  ${md}`,
    `    Assets:    ${assetsLine}`,
    '',
    '  Rules:',
    '   - DO NOT modify, rename, overwrite or delete any file inside this folder.',
    '   - If you need to use any of these files (the original PDF, an extracted',
    '     image, or even the markdown itself), COPY it first using the absolute tool',
    '     path to a working location such as /workspace/temp/ and operate on the copy.',
    '   - You CANNOT natively view PDFs. Calling read_file on the original PDF',
    '     path will always return THIS markdown transcription — that is intentional,',
    '     to avoid duplicate parsing and confusion.',
    '   - To inspect a specific extracted image, call read_file on the asset path',
    '     above (or copy the asset where you need it before processing).',
    '-->',
    HEADER_END,
    '',
    '',
  ].join('\n');
}

/** Strip the leading header block from a previously persisted markdown, if present. */
function stripPdfHeader(text) {
  if (typeof text !== 'string' || !text.startsWith(HEADER_BEGIN)) return text;
  const endIdx = text.indexOf(HEADER_END);
  if (endIdx < 0) return text;
  return text.slice(endIdx + HEADER_END.length).replace(/^\s*\n+/, '');
}

/**
 * Decide a non-conflicting parsed-folder path next to a `.pdf` source.
 */
function resolveParsedDirCandidate(absPdfPath) {
  const parent = path.dirname(absPdfPath);
  const originalName = path.basename(absPdfPath);
  const baseName = originalName.replace(/\.pdf$/i, '');
  let dirName = baseName;
  let counter = 1;
  while (fs.existsSync(path.join(parent, dirName))) {
    dirName = `${baseName}(${counter})`;
    counter++;
  }
  return {
    parsedDir: path.join(parent, dirName),
    dirName,
    originalName,
    baseName,
  };
}

/** True when `absDir` looks like a parsed-PDF folder (has transcription.md). */
function isParsedPdfDir(absDir) {
  try {
    return fs.statSync(absDir).isDirectory()
        && fs.existsSync(path.join(absDir, 'transcription.md'));
  } catch {
    return false;
  }
}

/**
 * If `absPdfPath` points to a missing .pdf but a sibling parsed dir exists, return it.
 * Used as a redirect helper when the AI calls read_file on the original .pdf path
 * after parsing has already happened.
 */
function findExistingParsedDirFor(absPdfPath) {
  const parent = path.dirname(absPdfPath);
  const baseName = path.basename(absPdfPath).replace(/\.pdf$/i, '');
  const candidates = [baseName];
  for (let i = 1; i <= 16; i++) candidates.push(`${baseName}(${i})`);
  for (const c of candidates) {
    const cand = path.join(parent, c);
    if (isParsedPdfDir(cand)) return cand;
  }
  return null;
}

/**
 * Locate the original PDF kept inside a parsed-PDF folder.
 * Returns the absolute path of the .pdf or null if missing (legacy folders
 * created by older versions might not contain it anymore).
 */
function findOriginalPdfInside(parsedDirAbs) {
  try {
    for (const f of fs.readdirSync(parsedDirAbs)) {
      if (/\.pdf$/i.test(f)) {
        const abs = path.join(parsedDirAbs, f);
        try { if (fs.statSync(abs).isFile()) return abs; } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * Parse a PDF buffer into a brand-new structured folder next to `absPdfPath`,
 * MOVING the original PDF file inside the new folder (it is never deleted).
 *
 * @param {object} args
 * @param {string} args.absPdfPath     - absolute path of the existing .pdf file
 * @param {Buffer} [args.buffer]       - raw PDF bytes (read from disk if omitted)
 * @param {string} args.virtualPdfPath - AI-visible path of the .pdf, used to
 *                                       compute the canonical paths in the header.
 *                                       e.g. "history/foo.pdf" or "/workspace/temp/foo.pdf"
 */
async function buildParsedPdfStructure({ absPdfPath, buffer, virtualPdfPath }) {
  const { extractTextFromPdfBuffer } = require('./media');
  if (!absPdfPath || typeof absPdfPath !== 'string') {
    return { success: false, error: 'Missing absPdfPath.' };
  }
  if (!fs.existsSync(absPdfPath)) {
    return { success: false, error: `PDF not found at ${absPdfPath}.` };
  }
  if (!buffer) {
    try { buffer = fs.readFileSync(absPdfPath); }
    catch (err) { return { success: false, error: `Cannot read PDF: ${err.message}` }; }
  }

  const { parsedDir, dirName, originalName } = resolveParsedDirCandidate(absPdfPath);

  // Compute virtual paths for the header (relative to the AI-visible parent).
  const cleanVirtualPdf = _normVirtual(virtualPdfPath);
  const slashIdx = cleanVirtualPdf.lastIndexOf('/');
  const virtualParent = slashIdx >= 0 ? cleanVirtualPdf.slice(0, slashIdx + 1) : '';
  const virtualDir         = `${virtualParent}${dirName}`;
  const virtualPdfInside   = `${virtualDir}/${originalName}`;
  const virtualMd          = `${virtualDir}/transcription.md`;
  const virtualAssets      = `${virtualDir}/assets`;

  try {
    fs.mkdirSync(parsedDir, { recursive: true });

    const info = await extractTextFromPdfBuffer(buffer, { persistDir: parsedDir });
    if (!info || !info.success || !info.text) {
      throw new Error(info?.error || 'OpenDataLoader returned invalid text');
    }

    const transcription = info.pages > MAX_DOC_PAGES
      ? `[Document too long to process: ${info.pages} pages (max ${MAX_DOC_PAGES})]`
      : info.text;

    const assetsDirAbs = path.join(parsedDir, 'assets');
    let assetCount = 0;
    try {
      if (fs.existsSync(assetsDirAbs)) assetCount = fs.readdirSync(assetsDirAbs).length;
    } catch { /* ignore */ }

    const mdAbs = path.join(parsedDir, 'transcription.md');
    const originalPdfAbs = path.join(parsedDir, originalName);
    const header = buildPdfHeader({
      virtualDir,
      virtualPdf: virtualPdfInside,
      virtualMd,
      virtualAssets,
      assetCount,
    });
    fs.writeFileSync(mdAbs, header + transcription, 'utf-8');

    // Move (not delete) the original PDF inside the parsed folder.
    try {
      fs.renameSync(absPdfPath, originalPdfAbs);
    } catch (err) {
      // Cross-device or busy file — fall back to copy + unlink.
      try {
        fs.copyFileSync(absPdfPath, originalPdfAbs);
        fs.unlinkSync(absPdfPath);
      } catch (err2) {
        throw new Error(`Failed to move original PDF inside parsed folder: ${err2.message}`);
      }
    }

    log.info(`✅ Parsed PDF structure built: ${cleanVirtualPdf} → ${virtualDir}/ (pages=${info.pages || '?'}, assets=${assetCount})`);
    return {
      success: true,
      parsedDirAbs: parsedDir,
      dirName,
      mdAbs,
      originalPdfAbs,
      assetsDirAbs: assetCount > 0 ? assetsDirAbs : null,
      assetCount,
      virtualDir,
      virtualPdfInside,
      virtualMd,
      virtualAssets,
      mdText: header + transcription,
      transcriptionOnly: transcription,
    };
  } catch (err) {
    try { fs.rmSync(parsedDir, { recursive: true, force: true }); } catch {}
    log.error(`❌ Parsed PDF structure build failed for ${cleanVirtualPdf}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * If a parsed-PDF folder predates the header convention (legacy entries
 * created before this feature, or whose md was overwritten), rewrite
 * `transcription.md` in place so it starts with the canonical header.
 *
 * @param {string} parsedDirAbs - absolute path to the parsed folder
 * @param {string} virtualDir   - AI-visible path of the folder (no trailing slash)
 * @returns {string} the (possibly updated) markdown text
 */
function ensureHeaderInTranscription(parsedDirAbs, virtualDir) {
  const mdAbs = path.join(parsedDirAbs, 'transcription.md');
  let text;
  try { text = fs.readFileSync(mdAbs, 'utf-8'); }
  catch { return ''; }

  if (text.startsWith(HEADER_BEGIN)) return text;

  const cleanVirtualDir = _normVirtual(virtualDir).replace(/\/+$/, '');
  const originalPdfAbs = findOriginalPdfInside(parsedDirAbs);
  const originalName = originalPdfAbs
    ? path.basename(originalPdfAbs)
    : `${path.basename(parsedDirAbs)}.pdf`;
  const virtualPdfInside = originalPdfAbs
    ? `${cleanVirtualDir}/${originalName}`
    : `${cleanVirtualDir}/${originalName}  (original missing — legacy folder)`;
  const virtualMd     = `${cleanVirtualDir}/transcription.md`;
  const virtualAssets = `${cleanVirtualDir}/assets`;
  const realAssets = path.join(parsedDirAbs, 'assets');

  let assetCount = 0;
  try {
    if (fs.existsSync(realAssets)) assetCount = fs.readdirSync(realAssets).length;
  } catch {}

  const header = buildPdfHeader({
    virtualDir: cleanVirtualDir,
    virtualPdf: virtualPdfInside,
    virtualMd,
    virtualAssets,
    assetCount,
  });
  const updated = header + text;
  try { fs.writeFileSync(mdAbs, updated, 'utf-8'); } catch { /* read-only fs — ignore */ }
  return updated;
}

module.exports = {
  HEADER_BEGIN,
  HEADER_END,
  buildPdfHeader,
  stripPdfHeader,
  resolveParsedDirCandidate,
  isParsedPdfDir,
  findExistingParsedDirFor,
  findOriginalPdfInside,
  buildParsedPdfStructure,
  ensureHeaderInTranscription,
};
