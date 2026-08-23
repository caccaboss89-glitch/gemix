// src/utils/deliverySelection.js
//
// Resolve the attachment entries the model selected for delivery (in the
// structured final reply or in a delivery tool's `attachments` parameter)
// into concrete attachment objects:
//   - namespace paths   -> the file itself, in `workspace/` or `attachments/`
//   - public https URLs -> downloaded into memory or disk
// Only listed files ship. A path is resolved as a path and nothing else: there
// is no basename lookup and no delivery buffer to search first (spec §18.16).
// A URL payload too big even for disk staging is delivered as a source link.

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { downloadPublicFile, downloadPublicFileToDisk, filenameFromPublicUrl  } from './fetch.js';
import { sanitizeFilename  } from './text.js';
import { uniqueAttachmentName  } from './attachments.js';
import { resolveAgentPath  } from '../sandbox/workspacePaths.js';
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
 * Resolve one public URL to an attachment, with a source-link fallback when
 * hosting it ourselves fails.
 *
 * @param {string} url
 * @param {Array<object>} existing
 * @returns {Promise<{ att: object|null, missing: boolean }>}
 */
async function resolveUrlEntry(url, existing = []) {
  const clean = String(url || '').trim();
  try {
    const att = await resolvePublicUrlAttachment(clean, existing);
    return { att, missing: false };
  } catch (err) {
    if (_isFileTooLargeError(err)) {
      return { att: createExternalUrlAttachment(clean, existing), missing: false };
    }
    return { att: null, missing: true, error: err };
  }
}

/**
 * Locate a file the model named by its namespace path, under either root.
 *
 * The model only ever names paths it has seen — what a producer tool returned,
 * what `list_files` showed, or an `[Attachment: attachments/x]` tag — so the
 * path is resolved literally. A name that does not resolve is missing, not a
 * cue to go looking for something with the same basename somewhere else.
 *
 * @param {string} entry - `workspace/report.pdf`, `attachments/photo.jpg`, …
 * @param {string} workspaceId
 * @returns {{ root: string, display: string, name: string, filePath: string }|null}
 */
function resolveLocalFileEntry(entry, workspaceId) {
  if (typeof entry !== 'string' || !entry.trim() || !workspaceId) return null;
  const resolved = resolveAgentPath(workspaceId, entry);
  if (!resolved || !resolved.relPath) return null;
  try {
    if (!fs.statSync(resolved.abs).isFile()) return null;
  } catch { return null; }
  return {
    root: resolved.root,
    display: resolved.display,
    name: path.basename(resolved.relPath),
    filePath: resolved.abs
  };
}

/**
 * @param {string[]} entries - Namespace paths and/or public https URLs.
 * @param {string|null} workspaceId - the conversation whose files may ship.
 * @returns {Promise<{ attachments: Array<object>, missing: string[] }>}
 */
async function resolveDeliverySelection(entries, workspaceId = null) {
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

    const local = resolveLocalFileEntry(entry, workspaceId);
    if (!local) {
      missing.push(entry);
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
