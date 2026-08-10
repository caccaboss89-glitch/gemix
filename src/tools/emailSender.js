// src/tools/emailSender.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Direct email sender using nodemailer + Gmail.
// Credentials are loaded exclusively from centralized env.js (envConfig.BOT_EMAIL / envConfig.BOT_PASS).
// Strips Discord emoji from subject and body via the discord util before delivery
// (keeps email text clean; Discord emoji are not desired in formal email output).
// Used by the email recipient tool and formal request flows.

import nodemailer from 'nodemailer';
import envConfig from '../config/env.js';
import { removeDiscordEmoji  } from '../utils/discord.js';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: envConfig.BOT_EMAIL,
    pass: envConfig.BOT_PASS
  }
});

/**
 * Send email directly to a specific address.
 */
async function sendEmailDirect(toEmail, subject, body, attachments = []) {
  subject = removeDiscordEmoji(subject);
  body = removeDiscordEmoji(body);
  await transporter.sendMail({
    from: `GemiX <${envConfig.BOT_EMAIL}>`,
    to: toEmail,
    subject,
    html: body,
    attachments
  });
}

export { sendEmailDirect
};
