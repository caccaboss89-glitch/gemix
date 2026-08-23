// src/tools/sendEmail.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and the result is a plain object the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// send_email: outbound only. Resolves the recipient, turns the model's HTML body
// into a safe one, embeds any `cid:` image it references, and attaches the rest
// — with a temp-link block appended for files too heavy to attach.

import { sendEmailDirect  } from './emailSender.js';
import { resolveActiveMemberByName, findMemberByEmail  } from '../config/members.js';
import { stripOutgoingDeliveryArtifacts  } from '../utils/text.js';
import { toEmailAttachment  } from '../utils/attachments.js';
import { buildFallbackAttachmentMessage  } from '../utils/attachmentFallback.js';
import { partitionAttachments, PLATFORM  } from '../utils/attachmentDelivery.js';
import {
  buildEmailBodyHtml,
  resolveInlineImages,
  appendHtmlBlock,
  buildNoticeBlock
} from '../utils/emailHtml.js';
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';
import { createLogger  } from '../utils/logger.js';
import {
  resolveOutboundAttachments,
  alreadyContactedError,
  recordOutbound
} from './outboundDelivery.js';

const log = createLogger('SendEmail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve the target email.
 * Non-member: blocked. Admin: any address. Active member: another member by name.
 * Otherwise: the caller themselves.
 */
function _resolveTargetEmail(args, userCtx) {
  if (!userCtx.isActiveMember) {
    return { error: { success: false, error: 'Only active members can send emails.' } };
  }
  const recipientEmail = args.recipient?.email;
  const recipientName = args.recipient?.name;

  if (userCtx.isAdmin && recipientEmail) {
    if (!EMAIL_RE.test(recipientEmail)) {
      return { error: { success: false, error: `Invalid email address format: "${recipientEmail}".` } };
    }
    return { email: recipientEmail, display: recipientEmail };
  }
  if (recipientName) {
    const resolved = resolveActiveMemberByName(recipientName);
    if (!resolved.ok) return { error: { success: false, error: resolved.error } };
    if (!resolved.member.email) {
      return { error: { success: false, error: `"${resolved.member.name}" has no email on file.` } };
    }
    return { email: resolved.member.email, display: resolved.member.name };
  }
  if (!userCtx.email) return { error: { success: false, error: 'No email address available.' } };
  return { email: userCtx.email, display: 'yourself' };
}

/** Recipient record for the sent-message log, enriched with member data when known. */
function _sentRecipient(target) {
  const member = findMemberByEmail(target.email);
  const digits = member ? String(member.wa || '').split('@')[0].split(':')[0].replace(/\D/g, '') : null;
  return {
    phone: digits || null,
    email: target.email || null,
    display: target.display || target.email || 'unknown'
  };
}

/**
 * @param {object} args - { recipient, subject, body, attachments? }
 * @param {object} userCtx
 * @param {object} deliveryCtx - { contactedEmail: Set }
 * @returns {Promise<object>} tool result
 */
async function sendEmailTool(args, userCtx, deliveryCtx) {
  const target = _resolveTargetEmail(args, userCtx);
  if (target.error) return target.error;

  const contacted = alreadyContactedError(deliveryCtx.contactedEmail, target.email, 'email');
  if (contacted) return contacted;

  const { attachments, missingNote } = await resolveOutboundAttachments(
    args.attachments, userCtx
  );
  const subject = stripOutgoingDeliveryArtifacts(args.subject || '');

  try {
    // The body is HTML by contract: sanitize and pass it through, then turn any
    // cid: reference into a real inline image.
    let bodyHtml = buildEmailBodyHtml(stripOutgoingDeliveryArtifacts(args.body || ''));
    const inlineResult = resolveInlineImages(bodyHtml, attachments);
    bodyHtml = inlineResult.html;

    // Files not embedded in the body go as normal attachments, with the usual
    // link fallback for anything too heavy to attach.
    const { direct, linkOnly } = partitionAttachments(inlineResult.rest, PLATFORM.EMAIL);
    const attached = direct
      .map(att => toEmailAttachment(att))
      .filter(a => a && a.filename && (a.content || a.path));

    if (linkOnly.length > 0) {
      let fallbackMessage;
      try {
        fallbackMessage = buildFallbackAttachmentMessage(linkOnly, { platform: PLATFORM.EMAIL }).message;
      } catch (err) {
        log.error(`Failed to generate email link-fallback: ${err.message}`);
        fallbackMessage = '⚠️ Alcuni allegati non hanno potuto essere inclusi direttamente nell\'email e non è stato possibile creare link temporanei.';
      }
      bodyHtml = appendHtmlBlock(bodyHtml, buildNoticeBlock(fallbackMessage));
    }

    await sendEmailDirect(target.email, subject, bodyHtml, [...inlineResult.inline, ...attached]);

    // Reserved only after a successful send, so a failure can be retried.
    deliveryCtx.contactedEmail.add(target.email);

    recordOutbound({
      senderKey: userCtx.taskFileId,
      channel: 'email',
      recipient: _sentRecipient(target),
      subject,
      body: stripOutgoingDeliveryArtifacts(args.body || ''),
      attachments
    });

    const counts = [
      attached.length > 0 ? ` with ${attached.length} attachment(s)` : '',
      linkOnly.length > 0 ? ` (${linkOnly.length} via links)` : ''
    ].join('');
    const inlineNote = inlineResult.inline.length > 0
      ? ` ${inlineResult.inline.length} image(s) embedded in the body.`
      : '';
    const unresolvedNote = inlineResult.unresolved.length > 0
      ? ` Removed cid reference(s) with no matching image file: ${inlineResult.unresolved.join(', ')}.`
      : '';

    return {
      success: true,
      message: `Email sent successfully to ${target.display}${counts}.${inlineNote}${unresolvedNote}${missingNote}`
    };
  } catch (err) {
    await notifyAdmin('Email Tool', `Failed to send email to ${target.email}: ${err.message}`);
    return { success: false, error: `Error sending email: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }
}

export { sendEmailTool
};
