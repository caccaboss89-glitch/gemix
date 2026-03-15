const nodemailer = require('nodemailer');
const { BOT_EMAIL, BOT_PASS } = require('../config/env');
const { findMemberByName } = require('../config/members');
const { generatePdf } = require('./pdfGenerator');

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
 * @returns {Promise<string>} Result message
 */
async function sendEmail(recipientName, subject, body, options = {}) {
  const member = findMemberByName(recipientName);
  if (!member) {
    return `Errore: "${recipientName}" non è un membro attivo. Non posso inviare email a non-membri.`;
  }

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

  await transporter.sendMail(mailOptions);
  return `Email inviata con successo a ${member.name} (${member.email}).`;
}

/**
 * Send email directly to a specific address (used by scheduler).
 */
async function sendEmailDirect(toEmail, subject, body, attachments = []) {
  await transporter.sendMail({
    from: `GemiX <${BOT_EMAIL}>`,
    to: toEmail,
    subject,
    html: body,
    attachments,
  });
}

module.exports = { sendEmail, sendEmailDirect };
