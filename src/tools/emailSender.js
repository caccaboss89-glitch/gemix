// src/tools/emailSender.js
//
// Direct email sender using nodemailer + Gmail.
// Credentials are loaded exclusively from centralized env.js (BOT_EMAIL / BOT_PASS).
// Strips Discord emoji from subject and body via the discord util before delivery
// (keeps email text clean; Discord emoji are not desired in formal email output).
// Used by the email recipient tool and formal request flows.

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
