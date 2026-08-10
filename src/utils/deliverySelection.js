// src/utils/deliverySelection.js
//
// Resolve the attachment entries the model selected for delivery (in the
// structured final reply or in a delivery tool's `attachments` parameter)
// into concrete attachment objects:
//   - delivery-buffer filenames -> the buffered attachment (by basename)
//   - public https URLs        -> downloaded into memory or disk
// Only listed files ship; everything else stays in the buffer.
// A URL payload too big even for disk staging is delivered as a source link.

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { downloadPublicFile, downloadPublicFileToDisk, filenameFromPublicUrl  } from './fetch.js';
import { sanitizeFilename  } from './text.js';
import { uniqueAttachmentName  } from './attachments.js';
import { applyBuildAgentFlags  } from './attachmentDelivery.js';
import { getHistoryDir  } from './userPaths.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import { TEMP_DIR  } from './tempFileServer.js';
import { createLogger  } from './logger.js';

const log = createLogger('DeliverySelection');

// Download caps. These bound what we are willing to pull off the network, and
// are deliberately unrelated to any platform's *send* cap: a file too large to
// attach on WhatsApp is still worth downloading, because it ships as a link.
const DEFAULT_URL_MAX_BYTES = 60 * 1024 * 1024;   // straight into memory
const DISK_URL_MAX_BYTES = 200 * 1024 * 1024;     // staged on disk instead

function _isFileTooLargeError(err) {
  return err && typeof err.message === 'string' && /File too large/i.test(err.message);
}

/**
 * Download a public URL into an attachment object. Over the in-memory limit it
 * retries onto disk with the larger DISK_URL_MAX_BYTES cap; only past that does
 * it give up and let the caller fall back to a source link.
 *
 * @param {string} url
 * @param {Array<object>} existing - attachments already resolved (for name dedup)
 * @returns {Promise<object>}
 */
async function resolvePublicUrlAttachment(url, existing = []) {
  const clean = String(url || '').trim();
  let dl;

  try {
    dl = await downloadPublicFile(clean, { maxBytes: DEFAULT_URL_MAX_BYTES });
  } catch (err) {
    if (!_isFileTooLargeError(err)) throw err;
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const safeStem = sanitizeFilename(filenameFromPublicUrl(clean)) || 'file';
    const destPath = path.join(TEMP_DIR, `dl_${crypto.randomBytes(12).toString('hex')}_${safeStem}`);
    const disk = await downloadPublicFileToDisk(clean, destPath, { maxBytes: DISK_URL_MAX_BYTES });
    dl = {
      filePath: disk.filePath,
      mimetype: disk.mimetype,
      filename: disk.filename
    };
  }

  const name = uniqueAttachmentName(existing, sanitizeFilename(dl.filename) || 'file');
  const att = { name, mimetype: dl.mimetype };
  if (dl.buffer) att.buffer = dl.buffer;
  if (dl.filePath) att.filePath = dl.filePath;
  return att;
}

/**
 * When download is impossible (over WhatsApp cap), keep the source URL so
 * delivery can still surface a direct link to the user.
 */
function createExternalUrlAttachment(url, existing = []) {
  const clean = String(url || '').trim();
  const rawName = filenameFromPublicUrl(clean);
  const name = uniqueAttachmentName(existing, sanitizeFilename(rawName) || 'file');
  const ext = path.extname(name).toLowerCase();
  return {
    name,
    mimetype: mimeForExtension(ext),
    externalUrl: clean
  };
}

/**
 * Resolve one public URL to an attachment, with optional build-agent flags and
 * source-link fallback when hosting fails.
 *
 * @param {string} url
 * @param {Array<object>} existing
 * @param {{ forBuild?: boolean }} [opts]
 * @returns {Promise<{ att: object|null, missing: boolean }>}
 */
async function resolveUrlEntry(url, existing = [], opts = {}) {
  const clean = String(url || '').trim();
  try {
    const att = await resolvePublicUrlAttachment(clean, existing);
    if (opts.forBuild) applyBuildAgentFlags(att);
    return { att, missing: false };
  } catch (err) {
    if (_isFileTooLargeError(err)) {
      return { att: createExternalUrlAttachment(clean, existing), missing: false };
    }
    return { att: null, missing: true, error: err };
  }
}

/**
 * Locate a file the model named by filename, in the one order every caller
 * uses: the delivery buffer first (what this turn produced), then the chat
 * history on disk. Only the basename is honoured — the model passes plain
 * filenames, never paths.
 *
 * A buffer hit also returns the buffered attachment itself (`att`), which
 * already carries its mimetype and delivery flags; a stale entry (filePath gone,
 * no buffer) falls through to history.
 *
 * @param {string} entry - filename with extension
 * @param {object} userCtx - resolves the history dir
 * @param {object} [responseCtx] - holds the delivery buffer
 * @returns {{ source: 'buffer'|'history', name: string, filePath?: string, buffer?: Buffer, att?: object }|null}
 */
function resolveLocalFileEntry(entry, userCtx, responseCtx) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const target = path.basename(entry.trim());

  const buffered = Array.isArray(responseCtx?.attachments)
    ? responseCtx.attachments.find(a => a && a.name && path.basename(a.name) === target)
    : null;
  if (buffered) {
    const name = path.basename(buffered.name);
    if (buffered.filePath && fs.existsSync(buffered.filePath)) {
      return { source: 'buffer', name, filePath: buffered.filePath, att: buffered };
    }
    if (Buffer.isBuffer(buffered.buffer)) {
      return { source: 'buffer', name, buffer: buffered.buffer, att: buffered };
    }
  }

  let historyDir = null;
  try { historyDir = getHistoryDir(userCtx); } catch { historyDir = null; }
  if (historyDir) {
    const candidate = path.join(historyDir, target);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { source: 'history', name: target, filePath: candidate };
      }
    } catch { /* unreadable → treated as missing */ }
  }
  return null;
}

/**
 * @param {string[]} entries - Buffer filenames and/or public https URLs.
 * @param {object} responseCtx - Holds the delivery buffer (responseCtx.attachments).
 * @param {object} [userCtx] - When provided, unresolved filenames are looked up
 *   in this user's chat history dir (so files only in history can still ship,
 *   now that the main brain has no read_file).
 * @returns {Promise<{ attachments: Array<object>, missing: string[] }>}
 */
async function resolveDeliverySelection(entries, responseCtx, userCtx = null) {
  const attachments = [];
  const missing = [];
  if (!Array.isArray(entries) || entries.length === 0) return { attachments, missing };

  const seen = new Set();
  for (const raw of entries) {
    const entry = String(raw || '').trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);

    if (/^https?:\/\//i.test(entry)) {
      const resolved = await resolveUrlEntry(entry, attachments);
      if (resolved.att) {
        attachments.push(resolved.att);
        if (resolved.att.externalUrl) {
          log.warn(`delivery URL too large to host; will send source link (${entry.slice(0, 100)})`);
        }
      } else {
        log.warn(`delivery URL download failed (${entry.slice(0, 100)}): ${resolved.error?.message || 'unknown'}`);
        missing.push(entry);
      }
      continue;
    }

    const local = userCtx || responseCtx
      ? resolveLocalFileEntry(entry, userCtx, responseCtx)
      : null;
    if (!local) {
      missing.push(entry);
      continue;
    }
    if (local.att) {
      // Already a well-formed attachment (mimetype + delivery flags): ship it.
      attachments.push(local.att);
      continue;
    }
    attachments.push({
      name: uniqueAttachmentName(attachments, local.name),
      filePath: local.filePath,
      mimetype: mimeForExtension(path.extname(local.name))
    });
  }

  return { attachments, missing };
}

export {
  resolveDeliverySelection,
  resolveLocalFileEntry,
  resolveUrlEntry

};
