// src/utils/attachments.js
// Unified attachment shape used across responseCtx.
// An attachment is: { name, mimetype, buffer?, filePath? }
//   - buffer:   Buffer already in memory (small/in-flight files: voice, formal PDF, generated media)
//   - filePath: absolute path on disk (workspace harvest, history, large files)
//
// At least one of buffer or filePath must be set. Helper functions handle
// read-on-demand from disk.

import fs from 'fs';
import path from 'path';

/**
 * WhatsApp direct-send cap: above this the file goes to a temp download link.
 * Held at WhatsApp's native media limit (16 MB) on purpose — whatsapp-web.js
 * sends media by injecting base64 into the WA Web page, and large payloads
 * (tens of MB) can detach/crash the Puppeteer frame, which then also kills the
 * follow-up messages (e.g. the link-fallback text). The link fallback delivers
 * big files reliably instead. Raise it only if your whatsapp-web.js build
 * reliably sends larger files directly.
 */
const WA_DIRECT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ name: string, mimetype: string, buffer?: Buffer, filePath?: string, sendAudioAsVoice?: boolean }} Attachment
 */

/**
 * Compute a buffer-unique filename. If `rawName`'s basename is already taken
 * by another attachment in `existing`, append "(1)", "(2)..." before the
 * extension until free. Returns the basename only (paths are never stored as
 * the logical name).
 *
 * @param {Attachment[]} existing
 * @param {string} rawName
 * @returns {string}
 */
function uniqueAttachmentName(existing, rawName) {
  const base = path.basename(String(rawName || 'file').trim()) || 'file';
  const taken = new Set(
    (Array.isArray(existing) ? existing : [])
      .map(a => (a && a.name ? path.basename(a.name) : null))
      .filter(Boolean)
  );
  if (!taken.has(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let i = 1;
  let candidate;
  do {
    candidate = `${stem}(${i})${ext}`;
    i++;
  } while (taken.has(candidate) && i < 100000);
  return candidate;
}

function isValidAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  if (!att.name || !att.mimetype) return false;
  const hasBuffer = Buffer.isBuffer(att.buffer);
  const hasPath = typeof att.filePath === 'string' && att.filePath.length > 0;
  return hasBuffer || hasPath;
}

/**
 * Resolve an attachment to an in-memory Buffer.
 * Reads from disk if only filePath is set.
 * @param {Attachment} att
 * @returns {Buffer|null}
 */
function readAttachmentBuffer(att) {
  if (!isValidAttachment(att)) return null;
  if (Buffer.isBuffer(att.buffer)) return att.buffer;
  try {
    return fs.readFileSync(att.filePath);
  } catch {
    return null;
  }
}

/**
 * Return the size in bytes of an attachment without necessarily loading it.
 */
function attachmentSize(att) {
  if (!att || typeof att !== 'object') return 0;
  if (Buffer.isBuffer(att.buffer)) return att.buffer.length;
  if (typeof att.filePath === 'string' && att.filePath.length > 0) {
    try { return fs.statSync(att.filePath).size; } catch { return 0; }
  }
  return 0;
}

/**
 * Shape an attachment for nodemailer. Prefers streaming from disk when possible.
 */
function toEmailAttachment(att) {
  if (!isValidAttachment(att)) return null;
  const base = { filename: att.name, contentType: att.mimetype };
  if (typeof att.filePath === 'string') return { ...base, path: att.filePath };
  return { ...base, content: att.buffer };
}

function isWhatsAppOversizedAttachment(att) {
  return attachmentSize(att) > WA_DIRECT_MAX_BYTES;
}

/**
 * Prefer a public temp download link over attempting a direct WA media send:
 * files over WA_DIRECT_MAX_BYTES (16 MB), whatever their source or type.
 * Failed direct sends still fall back to temp links.
 */
function shouldWhatsAppUseTempLink(att) {
  if (att?.sendAudioAsVoice) return false;
  return isWhatsAppOversizedAttachment(att);
}

/**
 * Shape an attachment for whatsapp-web.js MessageMedia.
 * Returns { mimetype, base64, name } that can be passed to `new MessageMedia(...)`.
 */
function toWhatsAppMediaArgs(att) {
  if (shouldWhatsAppUseTempLink(att)) {
    return null;
  }
  const buf = readAttachmentBuffer(att);
  if (!buf) return null;
  return { mimetype: att.mimetype, base64: buf.toString('base64'), name: att.name };
}

/**
 * Shape an attachment for Discord AttachmentBuilder. The filePath is used
 * for very large files on disk.
 * @returns {{ data: Buffer|string, name: string } | null}
 */
function toDiscordAttachmentArgs(att) {
  if (!isValidAttachment(att)) return null;
  if (typeof att.filePath === 'string') return { data: att.filePath, name: att.name };
  return { data: att.buffer, name: att.name };
}

export {
  uniqueAttachmentName,
  readAttachmentBuffer,
  attachmentSize,
  shouldWhatsAppUseTempLink,
  WA_DIRECT_MAX_BYTES,
  toEmailAttachment,
  toWhatsAppMediaArgs,
  toDiscordAttachmentArgs
};
