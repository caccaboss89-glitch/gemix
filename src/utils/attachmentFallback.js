// src/utils/attachmentFallback.js
// Link-fallback delivery for attachments that cannot be sent directly on a platform,
// or are routed to link delivery by platform policy (oversized, build audio/video,
// externalUrl). Hosts files on the temp server and builds Italian download messages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { registerTempFile, TEMP_DIR } = require('./tempFileServer');
const { createLogger } = require('./logger');
const { TEMP_ATTACHMENT_PREFIX } = require('../config/systemMessages');
const { shouldWhatsAppUseTempLink, readAttachmentBuffer, uniqueAttachmentName } = require('./attachments');
const { partitionAttachments, PLATFORM, hasExternalUrl } = require('./attachmentDelivery');

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

/** Prevent WhatsApp from wrapping https URLs at hyphen boundaries (e.g. gemix-allegati). */
function formatUrlForWhatsApp(url) {
  if (typeof url !== 'string' || !url) return url;
  return url.replace(/-/g, '-\u2060');
}

/**
 * Build an Italian system message with temp hosted links and/or passthrough source URLs.
 *
 * @param {Array<object>} linkFallbackAttachments - Policy-routed or send-failed attachments
 * @param {object} [options]
 * @returns {{ message: string, fallbackLinks: Array<{name: string, url: string, size: number, expiresInMinutes: number|null, external?: boolean}>, totalSize: number }}
 */
function buildFallbackAttachmentMessage(linkFallbackAttachments, options = {}) {
  if (!Array.isArray(linkFallbackAttachments) || linkFallbackAttachments.length === 0) {
    throw new Error('No link-fallback attachments provided');
  }

  const fallbackLinks = [];
  let totalSize = 0;

  log.info(`Processing ${linkFallbackAttachments.length} link-fallback attachment(s)...`);

  for (const att of linkFallbackAttachments) {
    try {
      if (hasExternalUrl(att)) {
        fallbackLinks.push({
          name: att.name || 'file',
          url: att.externalUrl.trim(),
          size: 0,
          expiresInMinutes: null,
          external: true,
        });
        continue;
      }

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
    }
  }

  if (fallbackLinks.length === 0) {
    throw new Error('No attachments were successfully registered for link fallback');
  }

  const isPlural = fallbackLinks.length > 1;
  const allegatiSuffix = isPlural ? 'i' : 'o';
  const disponibiliText = isPlural ? 'disponibili' : 'disponibile';
  const scaricaloText = isPlural ? 'Scaricali' : 'Scaricalo';

  const hasExternal = fallbackLinks.some(l => l.external);
  const hasHosted = fallbackLinks.some(l => !l.external);
  const expiryMin = hasHosted
    ? (fallbackLinks.find(l => !l.external)?.expiresInMinutes ?? 60)
    : null;
  const expiryLabel = expiryMin != null ? formatExpiryItalian(expiryMin) : null;

  let messageText = `${TEMP_ATTACHMENT_PREFIX}${allegatiSuffix} non ${disponibiliText} sulla piattaforma.\n\n`;
  if (hasHosted && !hasExternal) {
    messageText += `${scaricaloText} da questo link temporaneo (scade tra ${expiryLabel}):\n\n`;
  } else if (hasExternal && !hasHosted) {
    messageText += `${scaricaloText} da questo link:\n\n`;
  } else {
    messageText += `${scaricaloText} dai link qui sotto:\n\n`;
  }

  if (fallbackLinks.length === 1) {
    const link = fallbackLinks[0];
    const sizeMB = link.size > 0 ? (link.size / 1048576).toFixed(2) : null;
    const sizeLabel = sizeMB ? ` (${sizeMB} MB)` : '';
    messageText += `📄 ${link.name}${sizeLabel}\n${formatUrlForWhatsApp(link.url)}`;
  } else {
    messageText += fallbackLinks.map((link, idx) => {
      const sizeMB = link.size > 0 ? (link.size / 1048576).toFixed(2) : null;
      const sizeLabel = sizeMB ? ` (${sizeMB} MB)` : '';
      return `${idx + 1}. ${link.name}${sizeLabel}\n${formatUrlForWhatsApp(link.url)}`;
    }).join('\n\n');
  }

  if (hasHosted && expiryLabel) {
    messageText += `\n\nLink disponibile per ${expiryLabel}.`;
  }

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

/** Collapse multiple hostable WA temp-link files into one zip when possible. */
async function bundleWhatsAppTempLinkAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length <= 1) return attachments;

  const entries = [];
  const usedNames = [];
  for (const att of attachments) {
    if (hasExternalUrl(att)) continue;
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

async function _trySendAttachment(attachment, sendFunction) {
  try {
    await sendFunction(attachment);
    return { success: true, attachment };
  } catch (err) {
    return { success: false, error: err.message, attachment };
  }
}

/**
 * Send attachments: direct bucket first, then link fallback for policy-routed
 * items (WA) and send failures.
 *
 * @returns {Promise<{ sent: object[], linkFallback: object[], fallbackMessage: string|null, fallbackLinks: object[] }>}
 */
async function sendAttachmentsWithFallback(attachments, sendFunction, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { sent: [], linkFallback: [], fallbackMessage: null, fallbackLinks: [] };
  }

  const results = {
    sent: [],
    linkFallback: [],
    fallbackMessage: null,
    fallbackLinks: [],
  };

  let toTry = attachments;
  let linkRouted = [];

  if (options.platform === PLATFORM.WHATSAPP) {
    const { direct, linkOnly } = partitionAttachments(attachments, PLATFORM.WHATSAPP);
    toTry = direct;
    if (linkOnly.length > 0) {
      const external = linkOnly.filter(hasExternalUrl);
      const hostable = linkOnly.filter(a => !hasExternalUrl(a));
      linkRouted = [
        ...external,
        ...(await bundleWhatsAppTempLinkAttachments(hostable)),
      ];
      for (const att of linkOnly) {
        const label = att.name || 'unknown';
        if (hasExternalUrl(att)) {
          log.info(`WhatsApp source link: ${label}`);
        } else if (shouldWhatsAppUseTempLink(att)) {
          const reason = att.waTempLinkPreferred ? 'build media' : 'oversized';
          log.info(`WhatsApp temp link (${reason}): ${label}`);
        }
      }
    }
  }

  const sendFailed = [];
  for (const att of toTry) {
    const result = await _trySendAttachment(att, sendFunction);
    if (result.success) {
      results.sent.push(result.attachment);
      log.info(`Attachment sent: ${result.attachment.name || 'unknown'}`);
    } else {
      sendFailed.push(result.attachment);
      log.info(`Direct send failed (${result.attachment.name || 'unknown'}), using link fallback.`);
    }
  }

  let linkFallback = [...linkRouted, ...sendFailed];
  if (options.platform === PLATFORM.WHATSAPP && linkFallback.length > 0) {
    linkFallback = await bundleWhatsAppTempLinkAttachments(linkFallback);
  }
  results.linkFallback = linkFallback;

  if (linkFallback.length > 0) {
    try {
      const fallbackData = buildFallbackAttachmentMessage(linkFallback, options);
      results.fallbackMessage = fallbackData.message;
      results.fallbackLinks = fallbackData.fallbackLinks;
      log.info(`Generated link-fallback message for ${linkFallback.length} attachment(s)`);
    } catch (err) {
      log.error(`Failed to generate link-fallback message: ${err.message}`);
      results.fallbackMessage = '⚠️ I seguenti allegati non hanno potuto essere inviati e non è possibile creare un link di download temporaneo. Riprova più tardi.';
    }
  }

  return results;
}

module.exports = {
  buildFallbackAttachmentMessage,
  sendAttachmentsWithFallback,
};
