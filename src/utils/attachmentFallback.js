// src/utils/attachmentFallback.js
// Handles fallback for attachments that fail to send directly.
// When sending attachments fails, they are uploaded to temporary file server
// and a system message with download link is sent instead.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { registerTempFile, TEMP_DIR } = require('./tempFileServer');
const { createLogger } = require('./logger');
const { TEMP_ATTACHMENT_PREFIX } = require('../config/systemMessages');

const log = createLogger('AttachmentFallback');

/**
 * Process failed attachments and create a fallback message with download links.
 * 
 * @param {Array<object>} failedAttachments - Array of attachment objects that failed to send
 * @param {object} options
 * @param {string} options.platform - 'whatsapp' or 'discord' or 'email'
 * @returns {object} { message: string, fallbackLinks: Array<{name, url, size}> }
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
      // Log the failure and continue, avoiding cascading error for other files
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

  let messageText = `${TEMP_ATTACHMENT_PREFIX}${allegatiSuffix} non ${disponibiliText} sulla piattaforma.\n\n`;
  messageText += `${scaricaloText} da questo link temporaneo che scadrà tra un'ora:\n\n`;

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

  messageText += `\n\nLink disponibile per 1 ora.`;

  return {
    message: messageText,
    fallbackLinks,
    totalSize,
  };
}

/**
 * Attempt to send an attachment via a given send function.
 * Returns {success, error?, attachment?}
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
 * @returns {Promise<object>} { sent, failed, fallbackMessage?, fallbackLinks? }
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

  // Try to send each attachment
  for (const att of attachments) {
    const result = await trySendAttachment(att, sendFunction);
    if (result.success) {
      results.sent.push(result.attachment);
      log.info(`Attachment sent: ${result.attachment.name || 'unknown'}`);
    } else {
      results.failed.push(result.attachment);
      log.info(`Direct attachment sending unsupported/too large (${result.attachment.name || 'unknown'}), falling back to temp link.`);
    }
  }

  // If some failed, generate fallback message
  if (results.failed.length > 0) {
    try {
      const fallbackData = buildFallbackAttachmentMessage(results.failed, options);
      results.fallbackMessage = fallbackData.message;
      results.fallbackLinks = fallbackData.fallbackLinks;
      log.info(`Generated fallback message for ${results.failed.length} attachment(s)`);
    } catch (err) {
      log.error(`Failed to generate fallback message: ${err.message}`);
      // Don't re-throw; we tried our best
      results.fallbackMessage = `⚠️ I seguenti allegati non hanno potuto essere inviati e non è possibile creare un link di download temporaneo. Riprova più tardi.`;
    }
  }

  return results;
}

module.exports = {
  buildFallbackAttachmentMessage,
  trySendAttachment,
  sendAttachmentsWithFallback,
};
