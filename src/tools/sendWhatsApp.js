// src/tools/sendWhatsApp.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and the result is a plain object the dispatcher serializes into the
// fixed `{ success, message?, error?, ... }` envelope.
//
// send_whatsapp_message: deliver to a specific number, never to the current chat
// (replies there ride the structured response). Text goes first, then any files,
// with the usual temp-link fallback for what WhatsApp will not carry directly.

import { sendWhatsAppDirect, normalizePhoneToJid  } from './whatsappSender.js';
import { resolveActiveMemberByName, findMemberByWa  } from '../config/members.js';
import { stripOutgoingDeliveryArtifacts  } from '../utils/text.js';
import { sendAttachmentsWithFallback  } from '../utils/attachmentFallback.js';
import { sendWhatsAppAttachment, PLATFORM  } from '../utils/attachmentDelivery.js';
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

const log = createLogger('SendWhatsApp');

const MISSING_RECIPIENT_ERROR =
  'Missing recipient. send_whatsapp_message targets a specific phone number; use your structured reply for the current chat, not this tool.';

/**
 * Resolve the target JID.
 * Admin: external phone, or a member by name. Active member: other members by
 * name only. Never the current chat.
 */
function _resolveTargetJid(args, userCtx) {
  const recipientPhone = args.recipient?.phone;
  const recipientName = args.recipient?.name;

  if (userCtx.isAdmin && recipientPhone) {
    try {
      return { jid: normalizePhoneToJid(recipientPhone), display: recipientPhone };
    } catch (err) {
      return { error: { success: false, error: err.message } };
    }
  }
  if (recipientName && (userCtx.isAdmin || userCtx.isActiveMember)) {
    const resolved = resolveActiveMemberByName(recipientName);
    if (!resolved.ok) return { error: { success: false, error: resolved.error } };
    return { jid: resolved.member.wa, display: resolved.member.name };
  }
  return { error: { success: false, error: MISSING_RECIPIENT_ERROR } };
}

/** Recipient record for the sent-message log, enriched with member data when known. */
function _sentRecipient(target) {
  const digits = String(target.jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const member = digits ? findMemberByWa(`${digits}@c.us`) : null;
  return {
    phone: digits || null,
    email: member ? member.email || null : null,
    display: target.display || (digits ? `+${digits}` : 'unknown')
  };
}

function _directFailureReason(result, attachment) {
  return result.directFailures.find(entry => entry.attachment === attachment)?.error || null;
}

/** Original requested files represented by one fallback artifact (possibly a zip). */
function _fallbackSources(attachment) {
  return Array.isArray(attachment?.sourceAttachments) && attachment.sourceAttachments.length > 0
    ? attachment.sourceAttachments
    : [attachment];
}

function _fallbackFailure(result, entry, stage, fallbackError = null) {
  const directError = _directFailureReason(result, entry.attachment);
  const reasons = [];
  if (directError) reasons.push(`Direct delivery failed: ${directError}`);
  if (entry.error) reasons.push(`Link fallback failed: ${entry.error}`);
  if (fallbackError) reasons.push(`The fallback message was not sent: ${fallbackError}`);
  return {
    name: entry.attachment?.name || 'unknown',
    stage,
    error: reasons.join(' ') || 'Attachment delivery failed.'
  };
}

/**
 * Deliver resolved WhatsApp attachments and report only confirmed direct sends
 * and links whose fallback message was itself accepted by WhatsApp.
 */
async function deliverWhatsAppAttachments(attachments, sendDirectAttachment, sendFallbackMessage) {
  const result = await sendAttachmentsWithFallback(
    attachments,
    sendDirectAttachment,
    { platform: PLATFORM.WHATSAPP }
  );
  const failures = result.fallbackFailures.flatMap(entry =>
    _fallbackSources(entry.attachment).map(attachment =>
      _fallbackFailure(result, { attachment, error: entry.error }, 'link_generation')
    )
  );
  let linked = [];

  if (result.fallbackMessage) {
    try {
      await sendFallbackMessage(result.fallbackMessage);
      linked = result.fallbackAttachments.flatMap(_fallbackSources);
      if (linked.length > 0) {
        log.info(`Sent link-fallback message for ${linked.length} attachment(s)`);
      }
    } catch (err) {
      log.error(`Failed to send fallback message: ${err.message}`);
      for (const fallbackAttachment of result.fallbackAttachments) {
        for (const attachment of _fallbackSources(fallbackAttachment)) {
          failures.push(_fallbackFailure(
            result,
            { attachment, error: null },
            'link_delivery',
            err.message
          ));
        }
      }
    }
  }

  return {
    direct: result.sent,
    linked,
    failures,
    auditAttachments: [
      ...result.sent.map(att => auditAttachment(att, 'direct')),
      ...linked.map(att => auditAttachment(att, 'link'))
    ]
  };
}

/**
 * @param {object} args - { recipient, message, attachments? }
 * @param {object} userCtx
 * @param {object} deliveryCtx - { contactedWA: Set }
 * @returns {Promise<object>} tool result
 */
async function sendWhatsAppTool(args, userCtx, deliveryCtx) {
  if (typeof args.message !== 'string' || !args.message.trim()) {
    return { success: false, error: 'Missing "message" parameter. You must provide the text message to send.' };
  }

  const target = _resolveTargetJid(args, userCtx);
  if (target.error) return target.error;
  if (userCtx.waJid && target.jid === userCtx.waJid) {
    return { success: false, error: 'You cannot send to the current chat with this tool. Use your structured reply instead.' };
  }

  const contacted = alreadyContactedError(deliveryCtx.contactedWA, target.jid, 'WhatsApp message');
  if (contacted) return contacted;

  const { attachments, missing, missingNote } = resolveOutboundAttachments(args.attachments, userCtx);
  const text = stripOutgoingDeliveryArtifacts(args.message).trim();
  if (!text) {
    return {
      success: false,
      error: 'The WhatsApp message is empty after removing internal delivery markers.'
    };
  }
  try {
    await sendWhatsAppDirect(target.jid, text);
    // Reserved as soon as the text is out: a later attachment failure must not
    // let a retry blast the same text again.
    deliveryCtx.contactedWA.add(target.jid);
  } catch (err) {
    const notification = await notifyAdminDetailed(
      'WhatsApp Delivery',
      `Failed to send WhatsApp message to ${target.display}: ${err.message}`
    );
    return {
      success: false,
      error: `Error sending WhatsApp message: ${err.message}${buildAdminNotificationNote(notification)}`
    };
  }

  let attachmentResult = { direct: [], linked: [], failures: [], auditAttachments: [] };
  if (attachments.length > 0) {
    try {
      attachmentResult = await deliverWhatsAppAttachments(
        attachments,
        (att) => sendWhatsAppAttachment(att, (media, options) => sendWhatsAppDirect(target.jid, media, options)),
        (fallbackMessage) => sendWhatsAppDirect(target.jid, fallbackMessage)
      );
    } catch (err) {
      log.error(`Unexpected WhatsApp attachment delivery failure: ${err.message}`);
      attachmentResult.failures = attachments.map(att => ({
        name: att.name || 'unknown',
        stage: 'delivery',
        error: err.message
      }));
    }
  }

  const failures = [
    ...unresolvedAttachmentFailures(missing),
    ...attachmentResult.failures
  ];
  const attachmentDelivery = buildAttachmentDeliverySummary({
    selected: attachments.length + missing.length,
    direct: attachmentResult.direct.length,
    linked: attachmentResult.linked.length,
    failures
  });
  const deliveryStatus = outboundStatusFor(attachmentDelivery);
  log.info(`WhatsApp delivery: ${attachmentDelivery.direct} direct, `
    + `${attachmentDelivery.viaLinks} via link, ${attachmentDelivery.failed} failed`);

  const auditRecorded = await recordOutbound({
    senderKey: userCtx.taskFileId,
    channel: 'whatsapp',
    acceptanceStatus: 'accepted',
    toolStatus: deliveryStatus,
    recipient: _sentRecipient(target),
    text,
    attachments: attachmentResult.auditAttachments
  });
  const status = outboundStatusWithAudit(deliveryStatus, auditRecorded);

  const counts = attachmentDelivery.selected > 0
    ? ` Attachments: ${attachmentDelivery.direct} direct, ${attachmentDelivery.viaLinks} via links, `
      + `${attachmentDelivery.failed} failed.`
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
    message: `WhatsApp message accepted for outbound delivery to ${target.display}.${counts}${missingNote}${auditNote} `
      + 'This does not confirm delivery to the device or reading.',
    attachmentDelivery
  };
}

export { deliverWhatsAppAttachments, sendWhatsAppTool };
