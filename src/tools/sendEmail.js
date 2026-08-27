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
import {
  partitionAttachments,
  PLATFORM,
  EMAIL_MIME_ATTACHMENT_BUDGET_BYTES,
  estimateEmailMimeAttachmentBytes
} from '../utils/attachmentDelivery.js';
import {
  buildEmailBodyHtml,
  resolveInlineImages,
  appendHtmlBlock,
  buildNoticeBlock
} from '../utils/emailHtml.js';
import { buildAdminNotificationNote, notifyAdminDetailed } from '../utils/adminNotifier.js';
import { createLogger  } from '../utils/logger.js';
import {
  resolveOutboundAttachments,
  auditAttachment,
  buildAttachmentDeliverySummary,
  outboundStatusFor,
  outboundStatusWithAudit,
  unresolvedAttachmentFailures,
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

function _linkFailure(entry) {
  return {
    name: entry.attachment?.name || 'unknown',
    stage: 'link_generation',
    error: entry.error || 'The attachment could not be registered for link fallback.'
  };
}

function _escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove an inline image whose MIME part was rerouted to a download link. */
function _removeInlineCid(html, cid) {
  if (!cid) return html;
  const target = `cid:${cid}`;
  const escaped = _escapeRegExp(target);
  return String(html || '')
    .replace(new RegExp(`<img\\b[^>]*${escaped}[^>]*>`, 'gi'), '')
    .replace(new RegExp(escaped, 'gi'), '');
}

function _replaceInlineCid(html, fromCid, toCid) {
  if (!fromCid || !toCid || fromCid === toCid) return html;
  return String(html || '').replace(
    new RegExp(`cid:${_escapeRegExp(fromCid)}`, 'gi'),
    `cid:${toCid}`
  );
}

function _uniqueAttachments(attachments) {
  const seen = new Set();
  return (Array.isArray(attachments) ? attachments : []).filter(att => {
    if (!att || seen.has(att)) return false;
    seen.add(att);
    return true;
  });
}

/**
 * Build the email attachment payload and its truthful audit projection. A file
 * appears in auditAttachments only if it is embedded, attached, or represented
 * by a link actually included in the outgoing HTML.
 */
function prepareEmailAttachmentsForDelivery(bodyHtml, attachments, options = {}) {
  const selectedAttachments = Array.isArray(attachments) ? attachments : [];
  const inlineResult = resolveInlineImages(bodyHtml, selectedAttachments);
  let finalHtml = inlineResult.html;
  const sourceByName = new Map(
    selectedAttachments
      .filter(att => att?.name)
      .map(att => [String(att.name).toLowerCase(), att])
  );
  const inlinePairs = inlineResult.inline.map(mail => ({
    mail,
    source: sourceByName.get(String(mail.filename || '').toLowerCase()) || null
  }));

  const { direct, linkOnly: policyLinkOnly } = partitionAttachments(inlineResult.rest, PLATFORM.EMAIL);
  const attachedPairs = direct
    .map(source => ({ source, mail: toEmailAttachment(source) }))
    .filter(pair => pair.mail && pair.mail.filename && (pair.mail.content || pair.mail.path));
  const failures = direct
    .filter(source => !attachedPairs.some(pair => pair.source === source))
    .map(source => ({
      name: source.name || 'unknown',
      stage: 'attachment_conversion',
      error: 'The attachment could not be converted to an email attachment.'
    }));
  const requestedBudget = Number(options.mimeBudgetBytes);
  const mimeBudgetBytes = Number.isFinite(requestedBudget)
    ? Math.max(0, Math.floor(requestedBudget))
    : EMAIL_MIME_ATTACHMENT_BUDGET_BYTES;
  let estimatedMimeBytes = 0;
  const inline = [];
  const inlineSources = [];
  const attached = [];
  const attachedSources = [];
  const budgetOverflow = [];
  const inlineCidBySource = new Map();

  // Inline files are admitted first because the body already references them.
  // Repeated references to one source reuse its first CID and MIME part.
  for (const pair of inlinePairs) {
    if (!pair.source || !pair.mail || !(pair.mail.content || pair.mail.path)) {
      if (pair.source) budgetOverflow.push(pair.source);
      else failures.push({
        name: pair.mail?.filename || 'unknown',
        stage: 'attachment_conversion',
        error: 'The inline image could not be converted to an email attachment.'
      });
      finalHtml = _removeInlineCid(finalHtml, pair.mail?.cid);
      continue;
    }

    const existingCid = inlineCidBySource.get(pair.source);
    if (existingCid) {
      finalHtml = _replaceInlineCid(finalHtml, pair.mail.cid, existingCid);
      continue;
    }

    const estimated = estimateEmailMimeAttachmentBytes(pair.source);
    if (estimatedMimeBytes + estimated > mimeBudgetBytes) {
      budgetOverflow.push(pair.source);
      finalHtml = _removeInlineCid(finalHtml, pair.mail.cid);
      continue;
    }

    estimatedMimeBytes += estimated;
    inline.push(pair.mail);
    inlineSources.push(pair.source);
    inlineCidBySource.set(pair.source, pair.mail.cid);
  }

  for (const pair of attachedPairs) {
    const estimated = estimateEmailMimeAttachmentBytes(pair.source);
    if (estimatedMimeBytes + estimated > mimeBudgetBytes) {
      budgetOverflow.push(pair.source);
      continue;
    }
    estimatedMimeBytes += estimated;
    attached.push(pair.mail);
    attachedSources.push(pair.source);
  }

  const linkOnly = _uniqueAttachments([...policyLinkOnly, ...budgetOverflow]);
  let linked = [];

  if (linkOnly.length > 0) {
    let fallbackMessage;
    try {
      const fallback = buildFallbackAttachmentMessage(linkOnly, { platform: PLATFORM.EMAIL });
      fallbackMessage = fallback.message;
      linked = fallback.fallbackAttachments;
      failures.push(...fallback.failedAttachments.map(_linkFailure));
    } catch (err) {
      log.error(`Failed to generate email link-fallback: ${err.message}`);
      fallbackMessage = '⚠️ Alcuni allegati non hanno potuto essere inclusi direttamente nell\'email e non è stato possibile creare link temporanei.';
      const failedEntries = Array.isArray(err.failedAttachments)
        ? err.failedAttachments
        : linkOnly.map(attachment => ({ attachment, error: err.message }));
      failures.push(...failedEntries.map(_linkFailure));
    }
    finalHtml = appendHtmlBlock(finalHtml, buildNoticeBlock(fallbackMessage));
    if (failures.some(failure => failure.stage === 'link_generation') && linked.length > 0) {
      finalHtml = appendHtmlBlock(
        finalHtml,
        buildNoticeBlock('⚠️ Alcuni degli allegati richiesti non sono stati inclusi né resi disponibili tramite link.')
      );
    }
  }

  return {
    bodyHtml: finalHtml,
    mailAttachments: [...inline, ...attached],
    inline: inlineSources,
    attached: attachedSources,
    linked,
    failures,
    unresolved: inlineResult.unresolved,
    mimeBudget: {
      limitBytes: mimeBudgetBytes,
      estimatedBytes: estimatedMimeBytes,
      overflowed: _uniqueAttachments(budgetOverflow).length
    },
    auditAttachments: [
      ...inlineSources.map(att => auditAttachment(att, 'inline')),
      ...attachedSources.map(att => auditAttachment(att, 'attachment')),
      ...linked.map(att => auditAttachment(att, 'link'))
    ]
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

  const { attachments, missing, missingNote } = resolveOutboundAttachments(args.attachments, userCtx);
  const subject = stripOutgoingDeliveryArtifacts(args.subject || '');

  try {
    // The body is HTML by contract: sanitize and pass it through, then turn any
    // cid: reference into a real inline image.
    const prepared = prepareEmailAttachmentsForDelivery(
      buildEmailBodyHtml(stripOutgoingDeliveryArtifacts(args.body || '')),
      attachments
    );
    await sendEmailDirect(target.email, subject, prepared.bodyHtml, prepared.mailAttachments);

    // Reserved only after a successful send, so a failure can be retried.
    deliveryCtx.contactedEmail.add(target.email);

    const failures = [
      ...unresolvedAttachmentFailures(missing),
      ...prepared.failures,
      ...prepared.unresolved.map(name => ({
        name,
        stage: 'inline_reference',
        error: 'The cid reference had no matching image attachment and was removed from the email.'
      }))
    ];
    const attachmentDelivery = buildAttachmentDeliverySummary({
      selected: attachments.length + missing.length,
      direct: prepared.attached.length,
      embedded: prepared.inline.length,
      linked: prepared.linked.length,
      failures
    });
    const deliveryStatus = outboundStatusFor(attachmentDelivery);

    const auditRecorded = await recordOutbound({
      senderKey: userCtx.taskFileId,
      channel: 'email',
      acceptanceStatus: 'accepted',
      toolStatus: deliveryStatus,
      recipient: _sentRecipient(target),
      subject,
      body: stripOutgoingDeliveryArtifacts(args.body || ''),
      attachments: prepared.auditAttachments
    });
    const status = outboundStatusWithAudit(deliveryStatus, auditRecorded);

    const counts = attachmentDelivery.selected > 0
      ? ` Attachments: ${attachmentDelivery.direct} direct, ${attachmentDelivery.embedded} embedded, `
        + `${attachmentDelivery.viaLinks} via links, ${attachmentDelivery.failed} failed.`
      : '';
    const inlineNote = prepared.inline.length > 0
      ? ` ${prepared.inline.length} image(s) embedded in the body.`
      : '';
    const unresolvedNote = prepared.unresolved.length > 0
      ? ` Removed cid reference(s) with no matching image file: ${prepared.unresolved.join(', ')}.`
      : '';
    const auditNote = auditRecorded
      ? ''
      : ' The accepted send could not be saved to the read_sent_messages audit.';

    return {
      success: true,
      status,
      delivery_status: 'accepted',
      acceptanceStatus: 'accepted',
      toolStatus: status,
      audit_recorded: auditRecorded,
      message: `Email accepted for outbound delivery to ${target.display}.${counts}${inlineNote}${unresolvedNote}${missingNote}${auditNote} `
        + 'This does not confirm inbox delivery or reading.',
      attachmentDelivery,
      mimeBudget: prepared.mimeBudget
    };
  } catch (err) {
    const notification = await notifyAdminDetailed(
      'Email Tool',
      `Failed to send email to ${target.email}: ${err.message}`
    );
    return {
      success: false,
      error: `Error sending email: ${err.message}${buildAdminNotificationNote(notification)}`
    };
  }
}

export { prepareEmailAttachmentsForDelivery, sendEmailTool };
