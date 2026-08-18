// src/config/openaiFileMatrix.js
//
// Which files may be projected to GPT-5.6 Sol, and as what.
//
// The Codex backend rejects the whole request when one attachment has an
// unsupported type, so this matrix is fail-closed: a file is projected only when
// its extension, its MIME type and its actual magic bytes all agree on a form
// the backend was observed to accept. Anything else stays in the history as a
// tagged file the model is told about but does not receive.
//
// Probed on the OAuth Codex path (docs/deep-research/2026-08-16-openai-oauth-probe-results.md):
//   - PDF inline and by URL: accepted;
//   - WAV/MP3 as input_file, MP4 as input_file or input_video, and input_audio:
//     all rejected. Raw audio and video therefore never reach this model.
// The backend's own error listed a document whitelist (PDF, Office/OpenDocument,
// text, code, HTML, XML, CSV/TSV, EPUB, RTF, SRT/VTT, SVG); that list is treated
// as evidence, not as a contract, so only the entries below are sent.

import path from 'path';
import constants from './constants.js';
import { mimeBase } from './mimeExtensions.js';

/** How a file is projected into a Responses input item. */
const OPENAI_PROJECTION = {
  IMAGE: 'input_image',
  FILE: 'input_file',
  SKIP: 'skip'
};

/** Why a file was not projected. Surfaced verbatim in the attachment tag. */
const SKIP_REASON = {
  /** The type itself is fine elsewhere but this model cannot read it. */
  UNSUPPORTED: 'unsupported_by_openai',
  /** The file contradicts itself (fake MIME, wrong magic bytes, empty). */
  INVALID: 'invalid',
  /** Correct type, but larger than this profile sends inline. */
  TOO_LARGE: 'too_large',
  /** Audio reaches the model as a transcript in the same message instead. */
  TRANSCRIBED: 'audio_transcribed'
};

// Inline projection is the only option here: the OpenAI profile never uploads a
// file anywhere, so every byte travels inside the request. Base64 adds ~33%, and
// the whole 30-message window has to fit one HTTP body, hence caps lower than
// what the backend alone would take.
const MAX_IMAGE_BYTES = constants.MAX_IMAGE_BYTES;
const MAX_DOC_BYTES = 16 * 1024 * 1024;

/** Bytes read from the head of a file to identify it. */
const SNIFF_BYTES = 4096;
/** A GIF larger than this is over the image cap anyway; no point scanning it. */
const MAX_GIF_SCAN_BYTES = MAX_IMAGE_BYTES;

/** Extensions that make a file executable regardless of what follows them. */
const DANGEROUS_INNER_EXTS = new Set([
  '.exe', '.dll', '.so', '.bin', '.iso', '.dmg', '.lnk',
  '.bat', '.cmd', '.com', '.scr', '.msi', '.jar', '.apk'
]);

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * One accepted (extension → projection) entry.
 *   mimes:  MIME types allowed for it; a MIME outside the list is a conflict.
 *   magic:  predicate over the sniffed head, or null when the format has no
 *           reliable signature (textual formats, checked as text instead).
 */
const ACCEPTED = new Map([
  ['.png', { as: OPENAI_PROJECTION.IMAGE, mimes: ['image/png'], magic: (b) => _startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['.jpg', { as: OPENAI_PROJECTION.IMAGE, mimes: ['image/jpeg'], magic: (b) => _startsWith(b, [0xff, 0xd8, 0xff]) }],
  ['.jpeg', { as: OPENAI_PROJECTION.IMAGE, mimes: ['image/jpeg'], magic: (b) => _startsWith(b, [0xff, 0xd8, 0xff]) }],
  ['.webp', { as: OPENAI_PROJECTION.IMAGE, mimes: ['image/webp'], magic: _isWebp }],
  ['.gif', { as: OPENAI_PROJECTION.IMAGE, mimes: ['image/gif'], magic: _isGif }],

  ['.pdf', { as: OPENAI_PROJECTION.FILE, mimes: ['application/pdf'], magic: (b) => _startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) }],

  ['.docx', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.xlsx', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.pptx', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.odt', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.oasis.opendocument.text'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.ods', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.oasis.opendocument.spreadsheet'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.odp', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.oasis.opendocument.presentation'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.epub', { as: OPENAI_PROJECTION.FILE, mimes: ['application/epub+zip'], magic: (b) => _startsWith(b, ZIP_MAGIC) }],
  ['.doc', { as: OPENAI_PROJECTION.FILE, mimes: ['application/msword'], magic: (b) => _startsWith(b, OLE_MAGIC) }],
  ['.xls', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.ms-excel'], magic: (b) => _startsWith(b, OLE_MAGIC) }],
  ['.ppt', { as: OPENAI_PROJECTION.FILE, mimes: ['application/vnd.ms-powerpoint'], magic: (b) => _startsWith(b, OLE_MAGIC) }],
  ['.rtf', { as: OPENAI_PROJECTION.FILE, mimes: ['application/rtf', 'text/rtf'], magic: (b) => _startsWith(b, [0x7b, 0x5c, 0x72, 0x74, 0x66]) }]
]);

/**
 * Textual formats the backend accepts. They have no signature, so the check is
 * "is this really text": a NUL byte in the head means a binary wearing a .txt.
 */
const ACCEPTED_TEXT_EXTS = new Set([
  '.txt', '.md', '.rst', '.log', '.csv', '.tsv', '.srt', '.vtt',
  '.html', '.htm', '.xml', '.svg', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.ps1', '.makefile', '.dockerfile',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.pyw', '.rb', '.php',
  '.java', '.kt', '.scala', '.groovy', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.jl',
  '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.sql', '.graphql', '.gql',
  '.patch', '.diff'
]);

/** MIME families that identify a file as audio or video whatever it is called. */
const AUDIO_EXTS = new Set(['.ogg', '.opus', '.oga', '.mp3', '.wav', '.m4a', '.flac', '.aac', '.amr']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.3gp']);

function _startsWith(buf, bytes) {
  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

function _isWebp(buf) {
  return _startsWith(buf, [0x52, 0x49, 0x46, 0x46])
    && buf.length >= 12
    && buf.toString('ascii', 8, 12) === 'WEBP';
}

function _isGif(buf) {
  if (!buf || buf.length < 6) return false;
  const header = buf.toString('ascii', 0, 6);
  return header === 'GIF87a' || header === 'GIF89a';
}

/**
 * True when a GIF plays more than one frame.
 *
 * The single documented policy for this profile: an animated GIF is never sent
 * as a still image, because the model would describe one frame as if it were the
 * whole thing. It stays a tagged file instead.
 *
 * Detection is deliberately conservative — an unreadable or truncated GIF counts
 * as animated, so the ambiguous case degrades to a tag rather than to a wrong
 * still.
 *
 * @param {Buffer} buf - the whole file
 * @returns {boolean}
 */
function isAnimatedGif(buf) {
  if (!Buffer.isBuffer(buf) || !_isGif(buf)) return true;
  if (buf.length > MAX_GIF_SCAN_BYTES) return true;
  // The looping block that every animation tool writes.
  if (buf.includes('NETSCAPE2.0', 0, 'ascii')) return true;
  // Otherwise count graphic control extensions: one per displayed frame.
  const marker = Buffer.from([0x21, 0xf9, 0x04]);
  let found = 0;
  let at = buf.indexOf(marker);
  while (at !== -1) {
    if (++found > 1) return true;
    at = buf.indexOf(marker, at + marker.length);
  }
  return false;
}

/** Lowercase extension of a name, '' when it has none. */
function _extOf(name) {
  return path.extname(name || '').toLowerCase();
}

/**
 * True when a name hides an executable extension behind a harmless one
 * ("invoice.exe.pdf"). The magic-byte check already refuses the content, but
 * naming it is clearer than reporting a generic mismatch.
 */
function hasDangerousDoubleExtension(name) {
  const parts = String(name || '').toLowerCase().split('.');
  // parts[0] is the stem and the last one is the visible extension.
  for (let i = 1; i < parts.length - 1; i++) {
    if (DANGEROUS_INNER_EXTS.has(`.${parts[i]}`)) return true;
  }
  return false;
}

/**
 * Decide how one file is projected for the OpenAI profile.
 *
 * @param {object} file
 * @param {string} file.name - filename shown to the model
 * @param {string} [file.mimetype]
 * @param {number} file.sizeBytes
 * @param {Buffer} file.head - first SNIFF_BYTES bytes; must be the whole file for
 *   a GIF, whose frame count cannot be read from a prefix
 * @returns {{ as: string, reason?: string, detail?: string }}
 */
function classifyForOpenAi({ name, mimetype = '', sizeBytes, head }) {
  const ext = _extOf(name);
  const mime = mimeBase(mimetype);

  if (!(sizeBytes > 0)) {
    return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.INVALID, detail: 'empty file' };
  }
  if (hasDangerousDoubleExtension(name)) {
    return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.INVALID, detail: 'executable double extension' };
  }

  // Audio and video are refused by the backend in every observed form, so they
  // are named for what they are instead of falling through to "unknown type".
  if (AUDIO_EXTS.has(ext) || mime.startsWith('audio/')) {
    return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.TRANSCRIBED };
  }
  if (VIDEO_EXTS.has(ext) || mime.startsWith('video/')) {
    return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.UNSUPPORTED, detail: 'video' };
  }

  const entry = ACCEPTED.get(ext);
  if (entry) {
    if (mime && !entry.mimes.includes(mime)) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.INVALID, detail: `MIME "${mime}" does not match "${ext}"` };
    }
    if (entry.magic && !entry.magic(head)) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.INVALID, detail: `content is not a real ${ext.slice(1).toUpperCase()}` };
    }
    // A GIF is only cleared when the whole file was sniffed: a partial head
    // cannot prove a single frame.
    if (ext === '.gif' && (head.length < sizeBytes || isAnimatedGif(head))) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.UNSUPPORTED, detail: 'animated GIF' };
    }
    const cap = entry.as === OPENAI_PROJECTION.IMAGE ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;
    if (sizeBytes > cap) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.TOO_LARGE, detail: `over ${Math.round(cap / 1024 / 1024)} MB` };
    }
    return { as: entry.as };
  }

  if (ACCEPTED_TEXT_EXTS.has(ext)) {
    if (head && head.includes(0)) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.INVALID, detail: 'binary content in a text file' };
    }
    if (sizeBytes > MAX_DOC_BYTES) {
      return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.TOO_LARGE, detail: `over ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB` };
    }
    return { as: OPENAI_PROJECTION.FILE };
  }

  return { as: OPENAI_PROJECTION.SKIP, reason: SKIP_REASON.UNSUPPORTED, detail: ext ? `${ext} files` : 'unknown type' };
}

/** Human-readable note appended to the [Attachment] tag when a file is skipped. */
function skipNoteFor(reason, detail) {
  switch (reason) {
  case SKIP_REASON.TRANSCRIBED:
    return 'audio — transcript only, the clip itself is not readable';
  case SKIP_REASON.UNSUPPORTED:
    return `unsupported_by_openai${detail ? `: ${detail}` : ''}`;
  case SKIP_REASON.TOO_LARGE:
    return `not loaded${detail ? ` — ${detail}` : ''}`;
  case SKIP_REASON.INVALID:
    return `invalid${detail ? `: ${detail}` : ''}`;
  default:
    return 'not loaded';
  }
}

export {
  OPENAI_PROJECTION,
  SKIP_REASON,
  SNIFF_BYTES,
  MAX_IMAGE_BYTES as OPENAI_MAX_IMAGE_BYTES,
  MAX_DOC_BYTES as OPENAI_MAX_DOC_BYTES,
  classifyForOpenAi,
  isAnimatedGif,
  hasDangerousDoubleExtension,
  skipNoteFor
};
