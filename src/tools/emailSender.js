const nodemailer = require('nodemailer');
const { BOT_EMAIL, BOT_PASS } = require('../config/env');
const { findMemberByName } = require('../config/members');
const { generatePdf } = require('./pdfGenerator');
const { fetchWithTimeout } = require('../utils/fetch');
const { removeDiscordEmoji } = require('../utils/discord');
const { createLogger } = require('../utils/logger');

const log = createLogger('EmailSender');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: BOT_EMAIL,
    pass: BOT_PASS,
  },
});

/**
 * Send email to an active member.
 * @param {string} recipientName - Full name of the recipient (must be active member)
 * @param {string} subject
 * @param {string} body - HTML body
 * @param {object} [options]
 * @param {boolean} [options.attachPdf]
 * @param {string} [options.pdfTitle]
 * @param {string} [options.pdfContent]
 * @param {string[]} [options.imageUrls] - Array of image URLs to attach
 * @returns {Promise<string>} Result message
 */
async function sendEmail(recipientName, subject, body, options = {}) {
  const member = findMemberByName(recipientName);
  if (!member) {
    return `Errore: "${recipientName}" non è un membro attivo. Non posso inviare email a non-membri.`;
  }

  subject = removeDiscordEmoji(subject);
  body = removeDiscordEmoji(body);

  const mailOptions = {
    from: `GemiX <${BOT_EMAIL}>`,
    to: member.email,
    subject,
    html: body,
    attachments: [],
  };

  if (options.attachPdf && options.pdfContent) {
    const pdfBuffer = await generatePdf(options.pdfTitle || 'Documento', options.pdfContent);
    mailOptions.attachments.push({
      filename: `${(options.pdfTitle || 'documento').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    });
  }

  // Attach images from URLs
  if (options.imageUrls && Array.isArray(options.imageUrls) && options.imageUrls.length > 0) {
    for (let i = 0; i < options.imageUrls.length; i++) {
      try {
        const url = options.imageUrls[i];
        if (!url) continue;
        
        const res = await fetchWithTimeout(url);
        if (!res.ok) {
          log.warn(`Errore download immagine ${url}: ${res.status}`);
          continue;
        }
        
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        const filename = `image_${i + 1}.${contentType.split('/')[1] || 'jpg'}`;
        
        mailOptions.attachments.push({
          filename,
          content: buffer,
          contentType,
        });
      } catch (err) {
        log.warn(`Errore allegato immagine ${i + 1}:`, err.message);
      }
    }
  }

  // Attach accumulated attachments (from responseCtx)
  if (options.accumulatedAttachments && Array.isArray(options.accumulatedAttachments)) {
    mailOptions.attachments.push(...options.accumulatedAttachments);
  }

  await transporter.sendMail(mailOptions);
  return `Email inviata con successo a ${member.name} (${member.email}).`;
}

/**
 * Send email directly to a specific address (used by scheduler).
 */
async function sendEmailDirect(toEmail, subject, body, attachments = []) {
  subject = removeDiscordEmoji(subject);
  body = removeDiscordEmoji(body);
  await transporter.sendMail({
    from: `GemiX <${BOT_EMAIL}>`,
    to: toEmail,
    subject,
    html: body,
    attachments,
  });
}

module.exports = { sendEmail, sendEmailDirect };
