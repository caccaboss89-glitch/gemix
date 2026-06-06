// src/utils/attachmentFallback.js
// Provides fallback delivery for attachments that cannot be sent directly:
// uploads them to the temporary file server and includes download links in a system message.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { registerTempFile, TEMP_DIR } = require('./tempFileServer');
const { createLogger } = require('./logger');
const { TEMP_ATTACHMENT_PREFIX } = require('../config/systemMessages');
const { shouldWhatsAppUseTempLink, readAttachmentBuffer, uniqueAttachmentName } = require('./attachments');

const log = createLogger('AttachmentFallback');
const execFileAsync = promisify(execFile);

const WA_BUNDLE_ZIP_NAME = 'gemix-allegati.zip';

/** Human-readable Italian expiry from registerTempFile().expiresInMinutes */
function formatExpiryItalian(minutes) {
  const m = Math.max(1, Math.round(Number(minutes) || 60));
  if (m < 60) return m === 1 ? '1 minuto' : `${m} minuti`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const hPart = h === 1 ? "un'ora" : `${h} ore`;
  if (rem === 0) return hPart;
  const remPart = rem === 1 ? '1 minuto' : `${rem} minuti`;
  return `${hPart} e ${remPart}`;
}

/**
 * Process failed attachments and create a fallback message with download links.
 * 
 * @param {Array<object>} failedAttachments - Array of attachment objects that failed to send
 * @param {object} options
 * @param {string} options.platform - 'whatsapp' or 'discord' or 'email'
 * @returns {object} { message: string, fallbackLinks: Array<{name: string, token: string, url: string, size: number, expiresInMinutes: number}>, totalSize: number }
 * @throws {Error} if temp file registration fails
 */
function buildFallbackAttachmentMessage(failedAttachments, options = {}) {
  if (!Array.isArray(failedAttachments) || failedAttachments.length === 0) {
    throw new Error('No failed attachments provided');
  }

  const platform = options.platform || 'whatsapp';
  const fallbackLinks = [];
  let totalSize = 0;

  log.info(`Processing ${failedAttachments.length} failed attachment(s) for fallback...`);

  for (const att of failedAttachments) {
    try {
      let filePath = att.filePath;
      const pathExists = typeof filePath === 'string' && fs.existsSync(filePath);

      if (!pathExists && Buffer.isBuffer(att.buffer)) {
        if (!fs.existsSync(TEMP_DIR)) {
          fs.mkdirSync(TEMP_DIR, { recursive: true });
        }
        const uniqueName = `buf_${crypto.randomBytes(12).toString('hex')}_${att.name || 'file'}`;
        filePath = path.join(TEMP_DIR, uniqueName);
        fs.writeFileSync(filePath, att.buffer);
        att.filePath = filePath;
      }

      if (!filePath || !fs.existsSync(filePath)) {
        log.warn(`Attachment file not found: ${filePath}`);
        continue;
      }

      const stat = fs.statSync(filePath);
      const { token, url, expiresInMinutes } = registerTempFile(filePath, att.name || path.basename(filePath));

      fallbackLinks.push({
        name: att.name || path.basename(filePath),
        token,
        url,
        size: stat.size,
        expiresInMinutes,
      });

      totalSize += stat.size;
    } catch (err) {
      log.error(`Failed to register attachment "${att.name || 'unknown'}" as temp file: ${err.message}`);
      // Log registration failure for this attachment
    }
  }

  if (fallbackLinks.length === 0) {
    throw new Error('No attachments were successfully registered for fallback');
  }

  // Build the system message
  // Use singular/plural based on count
  const isPlural = fallbackLinks.length > 1;
  const allegatiSuffix = isPlural ? 'i' : 'o';
  const disponibiliText = isPlural ? 'disponibili' : 'disponibile';
  const scaricaloText = isPlural ? 'Scaricali' : 'Scaricalo';

  const expiryMin = fallbackLinks[0]?.expiresInMinutes ?? 60;
  const expiryLabel = formatExpiryItalian(expiryMin);

  let messageText = `${TEMP_ATTACHMENT_PREFIX}${allegatiSuffix} non ${disponibiliText} sulla piattaforma.\n\n`;
  messageText += `${scaricaloText} da questo link temporaneo (scade tra ${expiryLabel}):\n\n`;

  // Add links
  if (fallbackLinks.length === 1) {
    const link = fallbackLinks[0];
    const sizeMB = (link.size / 1048576).toFixed(2);
    messageText += `📄 ${link.name} (${sizeMB} MB)\n${link.url}`;
  } else {
    messageText += fallbackLinks.map((link, idx) => {
      const sizeMB = (link.size / 1048576).toFixed(2);
      return `${idx + 1}. ${link.name} (${sizeMB} MB)\n${link.url}`;
    }).join('\n\n');
  }

  messageText += `\n\nLink disponibile per ${expiryLabel}.`;

  return {
    message: messageText,
    fallbackLinks,
    totalSize,
  };
}

function _materializeAttachmentPath(att) {
  let filePath = att.filePath;
  if (typeof filePath === 'string' && fs.existsSync(filePath)) return filePath;
  const buf = readAttachmentBuffer(att);
  if (!buf) return null;
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const uniqueName = `buf_${crypto.randomBytes(12).toString('hex')}_${att.name || 'file'}`;
  filePath = path.join(TEMP_DIR, uniqueName);
  fs.writeFileSync(filePath, buf);
  att.filePath = filePath;
  return filePath;
}

async function _createZipArchive(zipPath, entries) {
  if (entries.length < 2) return false;
  if (process.platform === 'win32') {
    const staging = path.join(TEMP_DIR, `zipstage_${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const e of entries) {
        const dest = path.join(staging, e.name);
        fs.copyFileSync(e.path, dest);
      }
      const psPath = staging.replace(/'/g, "''");
      const psZip = zipPath.replace(/'/g, "''");
      await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `Compress-Archive -Path '${psPath}\\*' -DestinationPath '${psZip}' -Force`,
      ], { timeout: 120000 });
      return fs.existsSync(zipPath);
    } finally {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const args = ['-j', zipPath, ...entries.map(e => e.path)];
  await execFileAsync('zip', args, { timeout: 120000 });
  return fs.existsSync(zipPath);
}

/**
 * Collapse multiple temp-link attachments into one zip when possible (single download URL).
 * Falls back to the original list if bundling fails.
 */
async function bundleWhatsAppTempLinkAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length <= 1) return attachments;

  const entries = [];
  const usedNames = [];
  for (const att of attachments) {
    const p = _materializeAttachmentPath(att);
    if (!p) continue;
    const name = uniqueAttachmentName(
      usedNames.map(n => ({ name: n })),
      att.name || path.basename(p),
    );
    usedNames.push(name);
    entries.push({ path: p, name });
  }
  if (entries.length <= 1) return attachments;

  const zipPath = path.join(TEMP_DIR, `bundle_${crypto.randomBytes(12).toString('hex')}.zip`);
  try {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const ok = await _createZipArchive(zipPath, entries);
    if (ok) {
      log.info(`Bundled ${entries.length} WhatsApp temp-link attachment(s) into ${WA_BUNDLE_ZIP_NAME}`);
      return [{
        name: WA_BUNDLE_ZIP_NAME,
        mimetype: 'application/zip',
        filePath: zipPath,
      }];
    }
  } catch (err) {
    log.warn(`Zip bundle failed (${entries.length} files), using separate temp links: ${err.message}`);
  }
  return attachments;
}

function partitionWhatsAppAttachments(attachments) {
  const direct = [];
  const tempLink = [];
  for (const att of attachments) {
    if (shouldWhatsAppUseTempLink(att)) tempLink.push(att);
    else direct.push(att);
  }
  return { direct, tempLink };
}

/**
 * Attempt to send an attachment via a given send function.
 * Returns { success: boolean, error?: string, attachment?: object }
 * 
 * @param {object} attachment - Attachment to send
 * @param {Function} sendFunction - Async function that sends the attachment
 * @returns {Promise<object>}
 */
async function trySendAttachment(attachment, sendFunction) {
  try {
    await sendFunction(attachment);
    return { success: true, attachment };
  } catch (err) {
    return { success: false, error: err.message, attachment };
  }
}

/**
 * Send multiple attachments with fallback support.
 * Attempts to send each attachment. Failed ones are registered for temp download.
 * 
 * @param {Array<object>} attachments - Attachments to send
 * @param {Function} sendFunction - Async (attachment) => void function
 * @param {object} options
 * @param {string} options.platform - 'whatsapp', 'discord', 'email'
 * @returns {Promise<object>} { sent: Array, failed: Array, fallbackMessage: string|null, fallbackLinks: Array }
 */
async function sendAttachmentsWithFallback(attachments, sendFunction, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { sent: [], failed: [], fallbackMessage: null, fallbackLinks: [] };
  }

  const results = {
    sent: [],
    failed: [],
    fallbackMessage: null,
    fallbackLinks: [],
  };

  let toTry = attachments;
  let preFailed = [];

  if (options.platform === 'whatsapp') {
    const { direct, tempLink } = partitionWhatsAppAttachments(attachments);
    toTry = direct;
    if (tempLink.length > 0) {
      preFailed = await bundleWhatsAppTempLinkAttachments(tempLink);
      for (const att of tempLink) {
        const label = att.name || 'unknown';
        if (shouldWhatsAppUseTempLink(att)) {
          const reason = att.waTempLinkPreferred ? 'build media' : 'oversized';
          log.info(`WhatsApp temp link (${reason}): ${label}`);
        }
      }
    }
  }

  for (const att of toTry) {
    const result = await trySendAttachment(att, sendFunction);
    if (result.success) {
      results.sent.push(result.attachment);
      log.info(`Attachment sent: ${result.attachment.name || 'unknown'}`);
    } else {
      results.failed.push(result.attachment);
      log.info(`Direct attachment sending failed (${result.attachment.name || 'unknown'}), falling back to temp link.`);
    }
  }

  if (preFailed.length > 0 || results.failed.length > 0) {
    results.failed = await bundleWhatsAppTempLinkAttachments(
      [...preFailed, ...results.failed],
    );
  }

  if (results.failed.length > 0) {
    try {
      const fallbackData = buildFallbackAttachmentMessage(results.failed, options);
      results.fallbackMessage = fallbackData.message;
      results.fallbackLinks = fallbackData.fallbackLinks;
      log.info(`Generated fallback message for ${results.failed.length} attachment(s)`);
    } catch (err) {
      log.error(`Failed to generate fallback message: ${err.message}`);
      // Set default fallback message instead
      results.fallbackMessage = `⚠️ I seguenti allegati non hanno potuto essere inviati e non è possibile creare un link di download temporaneo. Riprova più tardi.`;
    }
  }

  return results;
}

module.exports = {
  buildFallbackAttachmentMessage,
  trySendAttachment,
  sendAttachmentsWithFallback,
  partitionWhatsAppAttachments,
  bundleWhatsAppTempLinkAttachments,
};
