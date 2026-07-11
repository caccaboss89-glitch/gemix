// src/utils/deliverySelection.js
//
// Resolve the attachment entries the model selected for delivery (in the
// structured final reply or in a delivery tool's `attachments` parameter)
// into concrete attachment objects:
//   - delivery-buffer filenames -> the buffered attachment (by basename)
//   - public https URLs        -> downloaded into memory or disk
// Only listed files ship; everything else stays in the buffer.
// Oversized URL payloads (>100 MB hosted) use source-link delivery on failure.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { downloadPublicFile, downloadPublicFileToDisk, filenameFromPublicUrl } = require('./fetch');
const { sanitizeFilename } = require('./text');
const {
  uniqueAttachmentName,
  WA_DIRECT_MAX_BYTES,
} = require('./attachments');
const { applyBuildAgentFlags } = require('./attachmentDelivery');
const { getHistoryDir } = require('./userPaths');
const { mimeForExtension } = require('../config/mimeExtensions');
const { TEMP_DIR } = require('./tempFileServer');
const { createLogger } = require('./logger');

const log = createLogger('DeliverySelection');

const DEFAULT_URL_MAX_BYTES = 60 * 1024 * 1024;

function _isFileTooLargeError(err) {
  return err && typeof err.message === 'string' && /File too large/i.test(err.message);
}

/**
 * Download a public URL into an attachment object. Retries with a higher cap
 * and disk storage when the default in-memory limit is exceeded.
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
    const disk = await downloadPublicFileToDisk(clean, destPath, { maxBytes: WA_DIRECT_MAX_BYTES });
    dl = {
      filePath: disk.filePath,
      mimetype: disk.mimetype,
      filename: disk.filename,
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
    externalUrl: clean,
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

  let historyDir = null;
  if (userCtx) {
    try { historyDir = getHistoryDir(userCtx); } catch { historyDir = null; }
  }

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

    const target = path.basename(entry);
    const found = Array.isArray(responseCtx?.attachments)
      ? responseCtx.attachments.find(a => a && a.name && path.basename(a.name) === target)
      : null;
    if (found) {
      attachments.push(found);
      continue;
    }

    if (historyDir) {
      const candidate = path.join(historyDir, target);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const name = uniqueAttachmentName(attachments, target);
          attachments.push({ name, filePath: candidate, mimetype: mimeForExtension(path.extname(target)) });
          continue;
        }
      } catch { /* fall through to missing */ }
    }

    missing.push(entry);
  }

  return { attachments, missing };
}

module.exports = {
  resolveDeliverySelection,
  resolvePublicUrlAttachment,
  resolveUrlEntry,
};
