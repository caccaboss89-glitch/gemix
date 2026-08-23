// src/tools/workspace/readFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and the envelope is the fixed `{ success, message?, error?, ... }`
// object, optionally followed by content parts.
//
// `read_file`: the one way the model reads anything on disk.
//
// The model does not pick a parser and does not know one exists. It names a
// path; this dispatches on the file type and returns a JSON envelope
// (`success/message/path/metadata`) plus, where a picture says more than text,
// image parts its vision reads directly.
//
// Host-side, in-process: reading runs GemiX's own code on GemiX's own disk.
//
// Phase 3 covers what needs no new dependency — text and code, and images.
// The document/audio/video branches answer with a structured
// PARSER_UNAVAILABLE rather than a guess; phase 5 replaces the table below
// with the ParserRegistry (Kreuzberg, poppler, ffmpeg, STT) and fills them in.

import fs from 'fs';
import path from 'path';
import constants from '../../config/constants.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { isProbablyText } from './textFiles.js';
import { INLINE_IMAGE_EXTS, inlineImagePart } from './inlineImage.js';

/** Longest slice of a text file returned in one call. */
const MAX_TEXT_BYTES = constants.WORKSPACE_OUTPUT_MAX_BYTES;

/** Structured reasons a read can fail, so the model can act on them. */
const READ_ERROR = Object.freeze({
  FILE_UNAVAILABLE: 'FILE_UNAVAILABLE',
  PARSER_UNAVAILABLE: 'PARSER_UNAVAILABLE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  TOO_LARGE: 'TOO_LARGE'
});

/** File families `read_file` recognizes, and how each is handled today. */
const DOCUMENT_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.odt', '.rtf', '.xlsx', '.xls', '.ods',
  '.pptx', '.ppt', '.odp', '.epub', '.eml', '.msg'
]);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
/** Never parsable and never useful to the model. */
const REFUSED_EXTS = new Set(['.exe', '.dll', '.so', '.bin', '.iso', '.dmg', '.lnk']);

function _familyOf(ext) {
  if (REFUSED_EXTS.has(ext)) return 'refused';
  if (INLINE_IMAGE_EXTS.has(ext)) return 'image';
  if (DOCUMENT_EXTS.has(ext)) return 'document';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'unknown';
}

function _metadata(display, stat, ext) {
  return {
    path: display,
    bytes: stat.size,
    modified: new Date(stat.mtimeMs).toISOString(),
    extension: ext || '(none)'
  };
}

function _pendingParser(kind, metadata) {
  return {
    success: false,
    error_code: READ_ERROR.PARSER_UNAVAILABLE,
    error: `No parser is wired up for ${kind} files yet, so this file cannot be read this way. `
      + 'You can still work on it with shell (ffmpeg, poppler, LibreOffice are in the workspace image).',
    metadata
  };
}

/**
 * @param {object} args
 * @param {string} args.path
 * @param {number} [args.offset] - first line to return, 1-based, text only
 * @param {number} [args.limit] - how many lines to return, text only
 * @param {string} workspaceId
 * @returns {object|Array} envelope, or [envelope, ...content parts]
 */
function readFile(args = {}, workspaceId) {
  const raw = typeof args.path === 'string' ? args.path : '';
  if (!raw.trim()) return { success: false, error: 'Missing required argument "path".' };

  const resolved = resolveAgentPath(workspaceId, raw);
  if (!resolved) return invalidPathError(raw);

  let stat;
  try { stat = fs.statSync(resolved.abs); }
  catch {
    return {
      success: false,
      error_code: READ_ERROR.FILE_UNAVAILABLE,
      error: `${resolved.display} does not exist. Use list_files to see what is there.`
    };
  }
  if (stat.isDirectory()) {
    return { success: false, error: `${resolved.display} is a directory. Use list_files on it.` };
  }

  const ext = path.extname(resolved.abs).toLowerCase();
  const metadata = _metadata(resolved.display, stat, ext);
  const family = _familyOf(ext);

  if (family === 'refused') {
    return {
      success: false,
      error_code: READ_ERROR.UNSUPPORTED_TYPE,
      error: `${resolved.display} is an executable or disk image and is never readable.`,
      metadata
    };
  }

  if (family === 'image') {
    const part = inlineImagePart(resolved.abs);
    if (!part) {
      return {
        success: false,
        error_code: READ_ERROR.TOO_LARGE,
        error: `${resolved.display} is an image but is too large to show `
          + `(cap ${Math.round(constants.MAX_IMAGE_BYTES / (1024 * 1024))} MB). `
          + 'Resize it with shell first.',
        metadata
      };
    }
    return [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          path: resolved.display,
          kind: 'image',
          metadata,
          message: 'Image attached below.'
        })
      },
      part
    ];
  }

  if (family === 'document') return _pendingParser('document', metadata);
  if (family === 'archive') return _pendingParser('archive', metadata);
  if (family === 'audio') return _pendingParser('audio', metadata);
  if (family === 'video') return _pendingParser('video', metadata);

  // Unknown extension: the content decides. This is what lets the agent read
  // its own `.log`, `.conf` and extension-less output without a list to keep.
  if (stat.size > MAX_TEXT_BYTES * 8) {
    return {
      success: false,
      error_code: READ_ERROR.TOO_LARGE,
      error: `${resolved.display} is ${Math.round(stat.size / 1024)} KB, too large to read whole. `
        + 'Use search_files to find the part you need, or slice it with shell.',
      metadata
    };
  }

  let buffer;
  try { buffer = fs.readFileSync(resolved.abs); }
  catch (err) {
    return {
      success: false,
      error_code: READ_ERROR.FILE_UNAVAILABLE,
      error: `Cannot read ${resolved.display}: ${err.message}`,
      metadata
    };
  }
  if (!isProbablyText(buffer)) {
    return {
      success: false,
      error_code: READ_ERROR.UNSUPPORTED_TYPE,
      error: `${resolved.display} is binary and has no known parser. Inspect it with shell if you need to.`,
      metadata
    };
  }

  const allLines = buffer.toString('utf-8').split(/\r?\n/);
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 1;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : allLines.length;
  const slice = allLines.slice(offset - 1, offset - 1 + limit);

  let content = slice.join('\n');
  let clipped = false;
  if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_BYTES) {
    content = Buffer.from(content, 'utf-8').subarray(0, MAX_TEXT_BYTES).toString('utf-8');
    clipped = true;
  }

  const shown = { from: offset, to: Math.min(offset - 1 + slice.length, allLines.length) };
  const notes = [];
  if (clipped) notes.push(`Output clipped at ${Math.round(MAX_TEXT_BYTES / 1024)} KB.`);
  if (shown.to < allLines.length) {
    notes.push(`Lines ${shown.from}-${shown.to} of ${allLines.length}; pass offset/limit for the rest.`);
  }

  return {
    success: true,
    path: resolved.display,
    kind: 'text',
    metadata: { ...metadata, lines: allLines.length },
    content,
    message: notes.join(' ') || `Full file, ${allLines.length} line(s).`
  };
}

export { readFile, READ_ERROR, MAX_TEXT_BYTES };
