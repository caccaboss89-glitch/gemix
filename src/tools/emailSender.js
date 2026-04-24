// src/tools/emailSender.js
const nodemailer = require('nodemailer');
const { BOT_EMAIL, BOT_PASS } = require('../config/env');
const { removeDiscordEmoji } = require('../utils/discord');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: BOT_EMAIL,
    pass: BOT_PASS,
  },
});

/**
 * Send email directly to a specific address.
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

module.exports = { sendEmailDirect };
