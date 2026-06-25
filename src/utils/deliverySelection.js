// src/utils/deliverySelection.js
//
// Resolve the attachment entries the model selected for delivery (in the
// structured final reply or in a delivery tool's `attachments` parameter)
// into concrete attachment objects:
//   - delivery-buffer filenames -> the buffered attachment (by basename)
//   - public https URLs        -> downloaded into memory
// Only listed files ship; everything else stays in the buffer.

const path = require('path');
const fs = require('fs');
const { downloadPublicFile } = require('./fetch');
const { sanitizeFilename } = require('./text');
const { uniqueAttachmentName } = require('./attachments');
const { getHistoryDir } = require('./userPaths');
const { mimeForExtension } = require('../config/mimeExtensions');
const { createLogger } = require('./logger');

const log = createLogger('DeliverySelection');

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
      try {
        const dl = await downloadPublicFile(entry);
        const name = uniqueAttachmentName(attachments, sanitizeFilename(dl.filename) || 'file');
        attachments.push({ name, buffer: dl.buffer, mimetype: dl.mimetype });
      } catch (err) {
        log.warn(`delivery URL download failed (${entry.slice(0, 100)}): ${err.message}`);
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

    // Fallback: a file that lives only in chat history (no longer in the
    // delivery buffer). Resolve it from disk so GemiX can re-send past files.
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

module.exports = { resolveDeliverySelection };
