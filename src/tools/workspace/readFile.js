// src/tools/workspace/readFile.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and the envelope is the fixed `{ success, message?, error?, ... }`
// object, optionally followed by content parts.
//
// `read_file`: the standard model-facing gateway for ingesting supported local files.
//
// The model does not pick a parser and does not know one exists. It names a
// path; the ParserRegistry decides what to run, and this returns a JSON
// envelope (`success/message/path/metadata`) plus, where a picture says more
// than text, image parts its vision reads directly — rendered PDF pages, video
// frames, figures out of a document.
//
// Host-side parsing uses a private snapshot opened through a descriptor-safe
// gateway, so model-created links cannot redirect a read outside either root.

import fs from 'fs';
import path from 'path';
import constants from '../../config/constants.js';
import { snapshotAgentFile } from '../../sandbox/hostFileGateway.js';
import { invalidPathError, parseAgentPath } from '../../sandbox/workspacePaths.js';
import { PARSE_ERROR, parse } from '../../parsers/parserRegistry.js';
import { inlineImagePartFromBuffer } from './inlineImage.js';

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

  const parsed = parseAgentPath(raw, opts);
  if (!parsed) return invalidPathError(raw, opts);

  // The gateway resolves in the full namespace, so it is handed the path this
  // chat resolved to and not the model's string: where the library is off,
  // `skills/x` is a workspace directory and must be read as one.
  let snapshot;
  try { snapshot = snapshotAgentFile(workspaceId, parsed.display); }
  catch (err) {
    return {
      success: false,
      error_code: READ_ERROR.FILE_UNAVAILABLE,
      error: `${parsed.display}: ${err.message}`
    };
  }
  if (!snapshot) {
    return {
      success: false,
      error_code: READ_ERROR.FILE_UNAVAILABLE,
      error: `${parsed.display} does not exist or is not a safe regular file. Use list_files to see what is there.`
    };
  }

  const stat = snapshot.stat;
  const ext = path.extname(snapshot.relPath).toLowerCase();
  const fileInfo = {
    path: snapshot.display,
    bytes: stat.size,
    modified: new Date(stat.mtimeMs).toISOString(),
    extension: ext || '(none)'
  };

  let result;
  let sourceImage = null;
  try {
    result = await parse(snapshot.filePath, {
      workspaceId,
      offset: args.offset,
      limit: args.limit,
      language: opts.language,
      signal: opts.signal
    });
    if (result.kind === 'image') {
      try { sourceImage = fs.readFileSync(snapshot.filePath); }
      catch { sourceImage = null; }
    }
  } finally {
    snapshot.cleanup();
  }

  if (!result.ok) {
    return {
      success: false,
      error_code: result.error_code || READ_ERROR.PARSER_UNAVAILABLE,
      error: `${snapshot.display}: ${result.error}`,
      metadata: fileInfo
    };
  }

  const metadata = { ...fileInfo, ...result.metadata };
  const notes = [...(result.notes || [])];
  const parts = [];

  // The file itself is the image, so it is attached whole rather than as a
  // derived one; everything else attaches what the parser produced.
  const source = result.kind === 'image'
    ? [{ buffer: sourceImage, mime: null }]
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
    status: metadata.has_more || metadata.output_truncated ? 'degraded' : 'ok',
    path: snapshot.display,
    kind: result.kind,
    metadata,
    message: notes.join(' ') || _defaultMessage(result, parts.length)
  };
  if (result.content) envelope.content = result.content;

  return parts.length > 0
    ? [{ type: 'input_text', text: JSON.stringify(envelope) }, ...parts]
    : envelope;
}

function _defaultMessage(result, attached) {
  if (result.kind === 'image') return attached > 0 ? 'Image attached below.' : 'Image metadata only.';
  if (result.kind === 'text') return `Full file, ${result.metadata?.lines ?? 0} line(s).`;
  return attached > 0 ? 'Parsed; images attached below.' : 'Parsed.';
}

export { readFile, READ_ERROR };
