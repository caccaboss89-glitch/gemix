// src/parsers/parserRegistry.js
//
// The one place that decides which parser reads a file.
//
// `read_file` calls `parse()` and gets back a single shape, whatever the file
// was. That indirection is the point: the tool contract the model sees does not
// change with the active parser stack or main-model profile. The model never
// learns a parser exists.
//
// Every result is `{ ok, kind, content, metadata, images, notes }`. `images`
// are raw buffers — rendered PDF pages, video frames, figures pulled out of a
// document — which the caller turns into content parts, because only the caller
// knows the per-turn inline budget.
//
// Results are cached by content hash, so re-reading the same attachment
// across turns costs one lookup. Images are cached too, base64 in the entry,
// which is what makes a re-read of a transcribed video free rather than another
// ffmpeg pass. A file whose bytes changed hashes differently and misses.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { isProbablyText } from '../tools/workspace/textFiles.js';
import { PARSE_ERROR } from './parseErrors.js';
import { handlesExt as isDocumentExt, parseDocument } from './documentParser.js';
import { familyOf as mediaFamilyOf, parseAudio, parseImage, parseVideo } from './mediaParser.js';
import { cacheKey, hashFile, readCache, writeCache } from './parserCache.js';
import { createLogger } from '../utils/logger.js';
import { normalizeSttLanguage, sttRouteId } from '../media/speechToText.js';

const log = createLogger('ParserRegistry');

/** Never parsable and never useful: executables and disk images. */
const REFUSED_EXTS = new Set(['.exe', '.dll', '.so', '.bin', '.iso', '.dmg', '.lnk']);

/**
 * Which parser owns a file, from its extension alone.
 * `text` is the fallback: content, not the extension, has the last word there.
 */
function familyFor(ext) {
  if (REFUSED_EXTS.has(ext)) return 'refused';
  const media = mediaFamilyOf(ext);
  if (media) return media;
  if (isDocumentExt(ext)) return 'document';
  return 'text';
}

/** Parsers whose work is expensive enough to be worth caching. */
const CACHEABLE = new Set(['document', 'audio', 'video']);

function _cacheParameters(family, ext, opts) {
  const params = { ext, ocr: opts.ocr !== false };
  if (family === 'audio' || family === 'video') {
    params.language = normalizeSttLanguage(opts.language);
    params.sttRoute = sttRouteId();
  }
  return params;
}

function _fail(code, error) {
  return { ok: false, error_code: code, error };
}

/** Cache entries are JSON, so image buffers travel base64 and come back Buffers. */
function _toCacheable(result) {
  return {
    ...result,
    images: (result.images || []).map(img => ({
      ...img,
      buffer: img.buffer.toString('base64')
    }))
  };
}

function _fromCache(entry) {
  return {
    ...entry,
    images: (entry.images || []).map(img => ({
      ...img,
      buffer: Buffer.from(img.buffer, 'base64')
    }))
  };
}

/** Read a text or code file, with the line window the model asked for. */
function _parseText(absPath, stat, opts) {
  const maxBytes = constants.WORKSPACE_OUTPUT_MAX_BYTES;
  if (stat.size > maxBytes * 8) {
    return _fail(
      PARSE_ERROR.TOO_LARGE,
      `This file is ${Math.round(stat.size / 1024)} KB, too large to read whole. `
      + 'Use search_files to find the part you need, or slice it with shell.'
    );
  }

  let buffer;
  try { buffer = fs.readFileSync(absPath); }
  catch (err) { return _fail(PARSE_ERROR.FILE_UNAVAILABLE, `Cannot read this file: ${err.message}`); }

  if (!isProbablyText(buffer)) {
    return _fail(
      PARSE_ERROR.UNSUPPORTED_TYPE,
      'This file is binary and has no known parser. Inspect it with shell if you need to.'
    );
  }

  const allLines = buffer.toString('utf-8').split(/\r?\n/);
  const offset = Number.isFinite(opts.offset) && opts.offset > 0 ? Math.floor(opts.offset) : 1;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : allLines.length;
  const slice = allLines.slice(offset - 1, offset - 1 + limit);

  let content = slice.join('\n');
  const notes = [];
  let outputTruncated = false;
  let fittedLines = null;
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    outputTruncated = true;
    let usedBytes = 0;
    fittedLines = 0;
    for (const line of slice) {
      const separatorBytes = fittedLines > 0 ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      if (usedBytes + separatorBytes + lineBytes > maxBytes) break;
      usedBytes += separatorBytes + lineBytes;
      fittedLines++;
    }
    if (fittedLines === 0) {
      return _fail(
        PARSE_ERROR.TOO_LARGE,
        `Line ${offset} alone exceeds the ${Math.round(maxBytes / 1024)} KB read_file output limit. `
        + 'Line paging cannot resume inside one line; use shell with byte-oriented commands such as '
        + '`dd`, `head -c` or `tail -c` to inspect it without skipping content.'
      );
    }
    content = slice.slice(0, fittedLines).join('\n');
    notes.push(`Output clipped at ${Math.round(maxBytes / 1024)} KB.`);
  }
  const returnedLines = fittedLines ?? (content.length > 0 ? content.split('\n').length : 0);
  const lastShown = returnedLines > 0 ? offset - 1 + returnedLines : offset - 1;
  const hasMore = outputTruncated || lastShown < allLines.length;
  if (offset > allLines.length) {
    notes.push(`Offset ${offset} is beyond the end of this ${allLines.length}-line file.`);
  } else if (hasMore) {
    notes.push(`Lines ${offset}-${lastShown} of ${allLines.length}; pass offset/limit for the rest.`);
  }

  return {
    ok: true,
    kind: 'text',
    content,
    metadata: {
      lines: allLines.length,
      offset,
      returned_lines: returnedLines,
      has_more: hasMore,
      ...(hasMore ? { next_offset: Math.max(offset, lastShown + 1) } : {}),
      output_truncated: outputTruncated
    },
    images: [],
    notes
  };
}

/** Run the parser for a family, with no caching concerns of its own. */
async function _dispatch(family, absPath, ext, stat, opts) {
  if (family === 'refused') {
    return _fail(PARSE_ERROR.UNSUPPORTED_TYPE, 'This is an executable or disk image and is never readable.');
  }
  if (family === 'image') return parseImage(absPath);
  if (family === 'audio') return parseAudio(absPath, opts);
  if (family === 'video') return parseVideo(absPath, opts);

  if (family === 'document') {
    if (stat.size > constants.PARSE_MAX_DOCUMENT_BYTES) {
      return _fail(
        PARSE_ERROR.TOO_LARGE,
        `This document is ${Math.round(stat.size / (1024 * 1024))} MB, over the `
        + `${Math.round(constants.PARSE_MAX_DOCUMENT_BYTES / (1024 * 1024))} MB parsing limit. Split it with shell first.`
      );
    }
    const result = await parseDocument(absPath, { ext, ocr: opts.ocr, signal: opts.signal });
    if (!result.ok) return _fail(PARSE_ERROR.PARSER_UNAVAILABLE, result.error);
    return result;
  }

  return _parseText(absPath, stat, opts);
}

/**
 * Parse one file for `read_file`.
 *
 * @param {string} absPath - host path, already resolved and contained
 * @param {object} [opts]
 * @param {string} [opts.workspaceId] - enables the cache; omit to bypass it
 * @param {number} [opts.offset] - first line, text only
 * @param {number} [opts.limit] - line count, text only
 * @param {boolean} [opts.ocr] - false to skip OCR on this read
 * @param {string} [opts.language] - STT hint
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   ok: boolean, error?: string, error_code?: string,
 *   kind?: string, content?: string, metadata?: object,
 *   images?: Array<{buffer: Buffer, mime: string, page?: number, label?: string}>,
 *   notes?: string[], cached?: boolean
 * }>}
 */
async function parse(absPath, opts = {}) {
  if (opts.signal?.aborted) throw opts.signal.reason || new Error('File parsing aborted.');
  let stat;
  try { stat = fs.statSync(absPath); }
  catch { return _fail(PARSE_ERROR.FILE_UNAVAILABLE, 'This file is not there any more.'); }
  if (!stat.isFile()) return _fail(PARSE_ERROR.UNSUPPORTED_TYPE, 'This is not a file.');

  const ext = path.extname(absPath).toLowerCase();
  const family = familyFor(ext);

  // A text read is already cheap, and its window changes per call; caching it
  // would cost a hash of the whole file to save a read of the same file.
  const cacheable = Boolean(opts.workspaceId) && CACHEABLE.has(family);
  let key = null;
  if (cacheable) {
    const contentHash = await hashFile(absPath, { signal: opts.signal });
    if (contentHash) {
      key = cacheKey(contentHash, family, _cacheParameters(family, ext, opts));
      const hit = readCache(opts.workspaceId, key);
      if (hit) return { ..._fromCache(hit), cached: true };
    }
  }

  const result = await _dispatch(family, absPath, ext, stat, opts);
  if (key && result.ok && result.cacheable !== false) {
    // A transient failure must not be remembered as this file's content, so
    // only a successful parse is stored.
    writeCache(opts.workspaceId, key, _toCacheable(result));
  }
  if (!result.ok) log.debug(`parse ${path.basename(absPath)} (${family}): ${result.error}`);
  return { images: [], notes: [], metadata: {}, ...result };
}

export {
  PARSE_ERROR,
  familyFor,
  _cacheParameters,
  parse
};
