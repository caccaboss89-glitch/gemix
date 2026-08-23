// src/tools/workspace/readFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and the envelope is the fixed `{ success, message?, error?, ... }`
// object, optionally followed by content parts.
//
// `read_file`: the one way the model reads anything on disk.
//
// The model does not pick a parser and does not know one exists. It names a
// path; the ParserRegistry decides what to run, and this returns a JSON
// envelope (`success/message/path/metadata`) plus, where a picture says more
// than text, image parts its vision reads directly — rendered PDF pages, video
// frames, figures out of a document.
//
// Host-side, in-process: reading runs GemiX's own code on GemiX's own disk.

import fs from 'fs';
import path from 'path';
import constants from '../../config/constants.js';
import { invalidPathError, resolveAgentPath } from '../../sandbox/workspacePaths.js';
import { PARSE_ERROR, parse } from '../../parsers/parserRegistry.js';
import { inlineImagePartFromBuffer } from './inlineImage.js';

/** Longest slice of a text file returned in one call. */
const MAX_TEXT_BYTES = constants.WORKSPACE_OUTPUT_MAX_BYTES;

/** Structured reasons a read can fail, so the model can act on them. */
const READ_ERROR = PARSE_ERROR;

/** How many images one read may attach, whatever the file produced. */
const MAX_ATTACHED_IMAGES = 8;

/** A human label for an attached image, so the model knows what it is looking at. */
function _imageLabel(kind, img, index) {
  if (img.page) return `page ${img.page}`;
  if (img.label) return kind === 'video' ? `frame at ${img.label}` : img.label;
  return `image ${index + 1}`;
}

/**
 * @param {object} args
 * @param {string} args.path
 * @param {number} [args.offset] - first line to return, 1-based, text only
 * @param {number} [args.limit] - how many lines to return, text only
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - the turn's deadline; a transcript that
 *   outlives the turn is work nobody is waiting for any more
 * @returns {Promise<object|Array>} envelope, or [envelope, ...content parts]
 */
async function readFile(args = {}, workspaceId, opts = {}) {
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
  const fileInfo = {
    path: resolved.display,
    bytes: stat.size,
    modified: new Date(stat.mtimeMs).toISOString(),
    extension: ext || '(none)'
  };

  const result = await parse(resolved.abs, {
    workspaceId,
    offset: args.offset,
    limit: args.limit,
    language: args.language,
    signal: opts.signal
  });

  if (!result.ok) {
    return {
      success: false,
      error_code: result.error_code || READ_ERROR.PARSER_UNAVAILABLE,
      error: `${resolved.display}: ${result.error}`,
      metadata: fileInfo
    };
  }

  const metadata = { ...fileInfo, ...result.metadata };
  const notes = [...(result.notes || [])];
  const parts = [];

  // The file itself is the image, so it is attached whole rather than as a
  // derived one; everything else attaches what the parser produced.
  const source = result.kind === 'image'
    ? [{ buffer: _readOrNull(resolved.abs), mime: null }]
    : (result.images || []);

  for (const [i, img] of source.slice(0, MAX_ATTACHED_IMAGES).entries()) {
    if (!img.buffer) continue;
    const part = inlineImagePartFromBuffer(img.buffer, img.mime || 'image/png');
    if (part) parts.push(part);
    else if (result.kind === 'image') {
      notes.push(`Too large to show inline (cap ${Math.round(constants.MAX_IMAGE_BYTES / (1024 * 1024))} MB). `
        + 'Resize it with shell first.');
    } else {
      notes.push(`Could not attach ${_imageLabel(result.kind, img, i)}.`);
    }
  }
  if (source.length > MAX_ATTACHED_IMAGES) {
    notes.push(`${source.length} images available; the first ${MAX_ATTACHED_IMAGES} are attached.`);
  }
  if (parts.length > 0 && result.kind !== 'image') {
    const labels = source.slice(0, parts.length).map((img, i) => _imageLabel(result.kind, img, i));
    notes.push(`Attached below, in order: ${labels.join(', ')}.`);
  }

  const envelope = {
    success: true,
    path: resolved.display,
    kind: result.kind,
    metadata,
    message: notes.join(' ') || _defaultMessage(result, parts.length)
  };
  if (result.content) envelope.content = result.content;

  return parts.length > 0
    ? [{ type: 'input_text', text: JSON.stringify(envelope) }, ...parts]
    : envelope;
}

function _readOrNull(absPath) {
  try { return fs.readFileSync(absPath); }
  catch { return null; }
}

function _defaultMessage(result, attached) {
  if (result.kind === 'image') return attached > 0 ? 'Image attached below.' : 'Image metadata only.';
  if (result.kind === 'text') return `Full file, ${result.metadata?.lines ?? 0} line(s).`;
  return attached > 0 ? 'Parsed; images attached below.' : 'Parsed.';
}

export { readFile, READ_ERROR, MAX_TEXT_BYTES, MAX_ATTACHED_IMAGES };
