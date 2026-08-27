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
import { notifyAdmin, ADMIN_NOTIFIED_SUFFIX  } from '../utils/adminNotifier.js';
import { createLogger  } from '../utils/logger.js';
import {
  resolveOutboundAttachments,
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

  const { attachments, missingNote } = await resolveOutboundAttachments(
    args.attachments, userCtx
  );
  const text = stripOutgoingDeliveryArtifacts(args.message);

  const audit = () => recordOutbound({
    senderKey: userCtx.taskFileId,
    channel: 'whatsapp',
    status: 'accepted',
    recipient: _sentRecipient(target),
    text,
    attachments
  });

  let textSent = false;
  try {
    await sendWhatsAppDirect(target.jid, text);
    textSent = true;
    // Reserved as soon as the text is out: a later attachment failure must not
    // let a retry blast the same text again.
    deliveryCtx.contactedWA.add(target.jid);

    let counts = '';
    if (attachments.length > 0) {
      const result = await sendAttachmentsWithFallback(
        attachments,
        (att) => sendWhatsAppAttachment(att, (media, options) => sendWhatsAppDirect(target.jid, media, options)),
        { platform: PLATFORM.WHATSAPP }
      );
      log.info(`WhatsApp delivery: ${result.sent.length} direct, ${result.linkFallback.length} via link`);

      if (result.fallbackMessage) {
        try {
          await sendWhatsAppDirect(target.jid, result.fallbackMessage);
          log.info(`Sent link-fallback message for ${result.linkFallback.length} attachment(s)`);
        } catch (err) {
          log.error(`Failed to send fallback message: ${err.message}`);
        }
      }
      counts = [
        result.sent.length > 0 ? ` with ${result.sent.length} attachment(s)` : '',
        result.linkFallback.length > 0 ? ` (${result.linkFallback.length} via links)` : ''
      ].join('');
    }

    audit();
    return {
      success: true,
      status: 'accepted',
      message: `WhatsApp message accepted for outbound delivery to ${target.display}${counts}.${missingNote} `
        + 'This does not confirm delivery to the device or reading.'
    };
  } catch (err) {
    // The text may already be out: log it so read_sent_messages still shows it.
    if (textSent) audit();
    await notifyAdmin('WhatsApp Delivery', `Failed to send WhatsApp message to ${target.display}: ${err.message}`);
    return { success: false, error: `Error sending WhatsApp message: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }
}

export { sendWhatsAppTool };
