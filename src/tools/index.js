// src/tools/index.js
//
// Central dispatcher for all tool calls from the main brain.
// Responsibilities: permission checks, schema validation via validateToolArgs,
// Per-round tool caps (generate_image/video, build, etc.), recipient resolution
// (for email/wa), the main execution switch, and unified error handling with
// admin notification on uncaught failures. All individual tools are required here.

const { getToolAccessError, validateToolArgs } = require('../ai/tools');
const { generateImage, generateVideo } = require('./imagineGenerator');
const { stripOutgoingDeliveryArtifacts } = require('../utils/text');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { generateFormalRequestPdf } = require('./formalRequestPdf');
const { sendEmailDirect } = require('./emailSender');
const { sendWhatsAppDirect } = require('./whatsappSender');
const { resolveActiveMemberByName, findMemberByWa, findMemberByEmail } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { recordSentMessage } = require('../utils/sentMessagesStore');
const { readSentMessages } = require('./sentMessagesReader');
const { readMusicStats } = require('./musicStats');
const { updatePrivateMemory } = require('./userMemory');
const { updateGroupMemory } = require('./groupMemory');
const { toggleReleaseNotify } = require('./releaseNotify');
const { buildTool } = require('./build');
const { pushBufferAttachment } = require('../utils/attachments');
const { musicCreator } = require('./musicCreator');
const { getGroupTaskFileId } = require('../utils/userIdentifier');
const { sanitizeFilename } = require('../utils/text');
const { resolveProfile, toolUnavailableMessage } = require('../config/platformCapabilities');
const { createLogger } = require('../utils/logger');
const { toEmailAttachment } = require('../utils/attachments');
const { sendAttachmentsWithFallback, buildFallbackAttachmentMessage } = require('../utils/attachmentFallback');
const { sendWhatsAppAttachment, partitionAttachments, PLATFORM } = require('../utils/attachmentDelivery');

const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { resolveDeliverySelection } = require('../utils/deliverySelection');
const { resetVoiceCount } = require('../utils/voiceCounter');
const {
  PER_ROUND_TOOL_LIMITS,
  perRoundCapErrorPayload,
} = require('../utils/toolCallExecution');
const log = createLogger('Tools');

function _getVoiceLimitChatKey(userCtx) {
  return userCtx?.chatId || userCtx?.groupId || userCtx?.waJid || userCtx?.userId || 'unknown';
}

/**
 * Escape HTML special characters to prevent injection in email bodies.
 */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WA_MISSING_RECIPIENT_ERROR =
  'Missing recipient. send_whatsapp_message targets a specific phone number; use your structured reply for the current chat, not this tool.';

/** Recipient record for a delivered WhatsApp message (enriched with member data). */
function _sentRecipientFromWa(targetJid) {
  const digits = String(targetJid.jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const member = digits ? findMemberByWa(digits + '@c.us') : null;
  return {
    phone: digits || null,
    email: member ? member.email || null : null,
    display: targetJid.display || (digits ? `+${digits}` : 'unknown'),
  };
}

/** Recipient record for a delivered email (enriched with member data when known). */
function _sentRecipientFromEmail(targetEmail) {
  const member = findMemberByEmail(targetEmail.email);
  const digits = member ? String(member.wa || '').split('@')[0].split(':')[0].replace(/\D/g, '') : null;
  return {
    phone: digits || null,
    email: targetEmail.email || null,
    display: targetEmail.display || targetEmail.email || 'unknown',
  };
}

/**
 * Resolve the target WhatsApp JID for delivery.
 * Admin: external phone/name only. Active member: other members by name. Never the current chat.
 */
function _resolveTargetWaJid(args, userCtx) {
  const recipientPhone = args.recipient?.phone;
  const recipientName = args.recipient?.name;

  if (userCtx.isAdmin) {
    if (recipientPhone) {
      try {
        const jid = normalizePhoneToJid(recipientPhone);
        return { jid, display: recipientPhone };
      } catch (err) {
        return { error: { success: false, error: err.message } };
      }
    }
    if (recipientName) {
      const resolved = resolveActiveMemberByName(recipientName);
      if (!resolved.ok) return { error: { success: false, error: resolved.error } };
      return { jid: resolved.member.wa, display: resolved.member.name };
    }
    return { error: { success: false, error: WA_MISSING_RECIPIENT_ERROR } };
  }
  if (userCtx.isActiveMember && recipientName) {
    const resolved = resolveActiveMemberByName(recipientName);
    if (!resolved.ok) return { error: { success: false, error: resolved.error } };
    return { jid: resolved.member.wa, display: resolved.member.name };
  }
  return { error: { success: false, error: WA_MISSING_RECIPIENT_ERROR } };
}

/**
 * Resolve the target email for delivery.
 * Non-member: blocked. Admin: any email. Active member: other members. Otherwise: self.
 */
function _resolveTargetEmail(args, userCtx) {
  if (!userCtx.isActiveMember) {
    return { error: { success: false, error: 'Only active members can send emails.' } };
  }
  const recipientEmail = args.recipient?.email;
  const recipientName = args.recipient?.name;

  if (userCtx.isAdmin) {
    if (recipientEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
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
  } else if (recipientName) {
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

function platformToolBlockReason(toolName, userCtx) {
  return getToolAccessError(toolName, userCtx, {
    unavailableMessage: (name) => toolUnavailableMessage(name, resolveProfile(userCtx), {
      isActiveMember: Boolean(userCtx.isActiveMember),
    }),
  });
}

/**
 * Execute a tool call and return the result.
 * Validates permissions, executes the tool, and collects responses/attachments.
 * @param {object} toolCall - The tool call from the AI model { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, isGroup, groupId }
 * @param {object} responseCtx - Mutable per-turn context { attachments, discordTitle, researchStats }
 * @param {object} deliveryCtx - Delivery tracking context { contactedWA: Set, contactedEmail: Set, roundToolCounts: Map }
 * @param {Array} [toolDefs] - Optional list of currently-allowed tool definitions, used for early arg validation.
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx, toolDefs = null) {
  const name = toolCall.function.name;

  // Voice streak counter resets when GemiX sends a text reply (handler.js), so
  // consecutive voice:true replies cannot exceed the per-chat limit.

  let args;
  try {
    const rawArgs = JSON.parse(toolCall.function.arguments || '{}');
    args = {};
    // Normalize keys: trim spaces to handle AI formatting errors (e.g., " text" instead of "text")
    for (const key of Object.keys(rawArgs)) {
      args[key.trim()] = rawArgs[key];
    }
  } catch {
    args = {};
  }

  // -- Schema validation -----------------------------------------------------
  // Catch obvious AI hallucinations (wrong types, missing required fields)
  // before we hand off to the individual tool implementation. We look up
  // the tool definition in the per-call list passed by the handler.
  if (Array.isArray(toolDefs)) {
    const toolDef = toolDefs.find(t => t && t.function && t.function.name === name);
    if (toolDef) {
      const validationError = validateToolArgs(args, toolDef);
      if (validationError) {
        return {
          toolCallId: toolCall.id,
          result: JSON.stringify({ success: false, error: validationError }),
        };
      }
    }
  }

  // -- Per-round caps (reserve slot before async work for parallel runs) --
  const roundCap = PER_ROUND_TOOL_LIMITS[name];
  if (Number.isFinite(roundCap) && roundCap >= 1) {
    const counts = deliveryCtx.roundToolCounts;
    const used = counts?.get(name) || 0;
    if (used >= roundCap) {
      return {
        toolCallId: toolCall.id,
        result: perRoundCapErrorPayload(name, roundCap),
      };
    }
    if (counts) counts.set(name, used + 1);
  }

  const platformBlock = platformToolBlockReason(name, userCtx);
  if (platformBlock) {
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ success: false, error: platformBlock }),
    };
  }

  let result;

  try {
    // Switch to recording state if the tool generates audio
    if (name === 'music_creator') {
      if (userCtx.presence && typeof userCtx.presence.setRecording === 'function') {
        await userCtx.presence.setRecording();
      }
    }

    switch (name) {
      case 'generate_image': {
        if (typeof userCtx.sendIntermediateNotification === 'function') {
          await userCtx.sendIntermediateNotification(
            'image_gen',
            '🎨 Sto generando l\'immagine, attendi un attimo...',
          );
        }
        result = await generateImage(args, userCtx, responseCtx);
        break;
      }

      case 'generate_video': {
        if (typeof userCtx.sendIntermediateNotification === 'function') {
          await userCtx.sendIntermediateNotification(
            'video_gen',
            '🎬 Sto generando il video (può richiedere qualche minuto), attendi un attimo...',
          );
        }
        result = await generateVideo(args, userCtx, responseCtx);
        break;
      }

      case 'build': {
        // Fire the "delegating to build team" banner once per AI call.
        if (typeof userCtx.sendIntermediateNotification === 'function') {
          const { buildEngineeringNotificationMessage } = require('../utils/notificationDedup');
          await userCtx.sendIntermediateNotification('build', buildEngineeringNotificationMessage());
        }
        result = await buildTool(args, userCtx, responseCtx);
        break;
      }

      case 'schedule_tasks': {
        const taskCtx = {
          taskFileId: userCtx.taskFileId,
          groupTaskFileId: userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null,
          userId: userCtx.userId,
          userName: userCtx.userName,
          waJid: userCtx.waJid,
          isActiveMember: userCtx.isActiveMember,
          isAdmin: userCtx.isAdmin,
          isGroup: userCtx.isGroup,
          groupId: userCtx.groupId,
        };
        result = await scheduleTasks(args.tasks, taskCtx);
        break;
      }

      case 'read_my_tasks': {
        const groupFileId = userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null;
        const includeGroup = Boolean(args.includeGroupTasks) && userCtx.isGroup && userCtx.platform && userCtx.platform.startsWith('whatsapp');
        if (args.includeGroupTasks && !includeGroup) {
          result = { success: false, error: 'includeGroupTasks not available: only in WhatsApp groups.' };
          break;
        }
        result = await readTasks(userCtx.taskFileId, groupFileId, includeGroup);
        break;
      }

      case 'remove_my_tasks': {
        const allowGroup = userCtx.isGroup && userCtx.platform && userCtx.platform.startsWith('whatsapp');
        if (args.fromGroup && !allowGroup) {
          result = {
            success: false,
            error: 'fromGroup is only available in WhatsApp group chats. Remove tasks from your personal task file instead.',
          };
          break;
        }
        const fileId = args.fromGroup && allowGroup
          ? getGroupTaskFileId(userCtx.groupId)
          : userCtx.taskFileId;
        result = await removeTasks(args.taskIds, fileId);
        break;
      }

      case 'read_server_rules': {
        result = await readServerRules();
        break;
      }

      case 'generate_formal_request_pdf': {
        try {
          const formalPdfBuffer = await generateFormalRequestPdf({
            fullName: args.fullName,
            title: args.title,
            motivation: args.motivation,
            requesterSignature: args.requesterSignature,
            legalSignature: args.legalSignature,
          });
          const formalFileName = `Richiesta_${sanitizeFilename(args.title || 'formale')}.pdf`;
          const formalFinalName = pushBufferAttachment(responseCtx, {
            name: formalFileName,
            buffer: formalPdfBuffer,
            mimetype: 'application/pdf',
          });
          result = {
            success: true,
            filename: formalFinalName,
            message: `Formal request PDF generated successfully and pushed to the delivery buffer as "${formalFinalName}".`,
          };
        } catch (err) {
          await notifyAdmin('Formal PDF Tool', `Failed to generate PDF: ${err.message}`);
          result = { success: false, error: `Error generating formal request PDF: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
        }
        break;
      }

      case 'send_email': {
        const targetEmail = _resolveTargetEmail(args, userCtx);
        if (targetEmail.error) { result = targetEmail.error; break; }
        if (deliveryCtx.contactedEmail.has(targetEmail.email)) {
          result = { success: false, error: `You have already sent an email to this address. Each email can only receive 1 message per request.` };
          break;
        }
        deliveryCtx.contactedEmail.add(targetEmail.email);
        // Files explicitly selected by the model (delivery-buffer names or public URLs).
        const emailSelection = await resolveDeliverySelection(args.attachments, responseCtx, userCtx);
        const emailMissingNote = emailSelection.missing.length > 0
          ? ` Attachment(s) not resolved and NOT sent: ${emailSelection.missing.join(', ')}.`
          : '';
        try {
          // Partition into direct email attach vs link-only fallback
          if (emailSelection.attachments.length > 0) {
            const { direct: directAtts, linkOnly: linkOnlyAtts } = partitionAttachments(
              emailSelection.attachments,
              PLATFORM.EMAIL,
            );
            const sent = directAtts
              .map(att => toEmailAttachment(att))
              .filter(emailAtt => emailAtt && emailAtt.filename && (emailAtt.content || emailAtt.path));

            let fallbackMessage = null;
            if (linkOnlyAtts.length > 0) {
              try {
                const fallbackData = buildFallbackAttachmentMessage(linkOnlyAtts, { platform: 'email' });
                fallbackMessage = fallbackData.message;
              } catch (err) {
                log.error(`Failed to generate email link-fallback: ${err.message}`);
                fallbackMessage = '⚠️ Alcuni allegati non hanno potuto essere inclusi direttamente nell\'email e non è stato possibile creare link temporanei.';
              }
            }

            let emailBodyHtml = `<div style="font-family:sans-serif">${_escapeHtml(stripOutgoingDeliveryArtifacts(args.body || '')).replace(/\n/g, '<br>')}</div>`;

            if (fallbackMessage) {
              emailBodyHtml += `<br><hr style="border:0;border-top:1px solid #ccc;margin:20px 0;"><div style="font-family:sans-serif;color:#555;">${_escapeHtml(fallbackMessage).replace(/\n/g, '<br>')}</div>`;
            }

            // Send main email with all direct attachments
            await sendEmailDirect(
              targetEmail.email,
              stripOutgoingDeliveryArtifacts(args.subject || ''),
              emailBodyHtml,
              sent
            );

            result = { success: true, message: `Email sent successfully to ${targetEmail.display}${sent.length > 0 ? ` with ${sent.length} attachment(s)` : ''}${linkOnlyAtts.length > 0 ? ` (${linkOnlyAtts.length} via links)` : ''}.${emailMissingNote}` };
          } else {
            await sendEmailDirect(
              targetEmail.email,
              stripOutgoingDeliveryArtifacts(args.subject || ''),
              `<div style="font-family:sans-serif">${_escapeHtml(stripOutgoingDeliveryArtifacts(args.body || '')).replace(/\n/g, '<br>')}</div>`,
              []
            );
            result = { success: true, message: `Email sent successfully to ${targetEmail.display}.${emailMissingNote}` };
          }
          // Log this outgoing message so the caller can later confirm it was sent.
          recordSentMessage({
            senderKey: userCtx.taskFileId,
            channel: 'email',
            recipient: _sentRecipientFromEmail(targetEmail),
            subject: stripOutgoingDeliveryArtifacts(args.subject || ''),
            body: stripOutgoingDeliveryArtifacts(args.body || ''),
            attachments: emailSelection.attachments,
          });
        } catch (err) {
          await notifyAdmin('Email Tool', `Failed to send email to ${targetEmail.email}: ${err.message}`);
          result = { success: false, error: `Error sending email: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
        }
        break;
      }

      case 'send_whatsapp_message': {
        if (!args.message || typeof args.message !== 'string' || args.message.trim().length === 0) {
          result = { success: false, error: 'Missing "message" parameter. You must provide the text message to send.' };
          break;
        }

        const targetJid = _resolveTargetWaJid(args, userCtx);
        if (targetJid.error) { result = targetJid.error; break; }
        if (userCtx.waJid && targetJid.jid === userCtx.waJid) {
          result = { success: false, error: 'You cannot send to the current chat with this tool. Use your structured reply instead.' };
          break;
        }
        if (deliveryCtx.contactedWA.has(targetJid.jid)) {
          result = { success: false, error: `You have already sent a WhatsApp message to this number. Each number can only receive 1 message per request.` };
          break;
        }
        deliveryCtx.contactedWA.add(targetJid.jid);
        // Files explicitly selected by the model (delivery-buffer names or public URLs).
        const waSelection = await resolveDeliverySelection(args.attachments, responseCtx, userCtx);
        const waMissingNote = waSelection.missing.length > 0
          ? ` Attachment(s) not resolved and NOT sent: ${waSelection.missing.join(', ')}.`
          : '';
        try {
          await sendWhatsAppDirect(targetJid.jid, stripOutgoingDeliveryArtifacts(args.message));
          if (waSelection.attachments.length > 0) {
            // Try to send attachments with fallback support
            const sendAttachment = async (att) => {
              await sendWhatsAppAttachment(att, (media, options) => sendWhatsAppDirect(targetJid.jid, media, options));
            };

            const sendResult = await sendAttachmentsWithFallback(
              waSelection.attachments,
              sendAttachment,
              { platform: 'whatsapp' }
            );

            log.info(`WhatsApp delivery: ${sendResult.sent.length} direct, ${sendResult.linkFallback.length} via link`);

            if (sendResult.fallbackMessage) {
              try {
                await sendWhatsAppDirect(targetJid.jid, sendResult.fallbackMessage);
                log.info(`Sent link-fallback message for ${sendResult.linkFallback.length} attachment(s)`);
              } catch (err) {
                log.error(`Failed to send fallback message: ${err.message}`);
              }
            }

            const attachmentsSentCount = sendResult.sent.length;
            const attachmentsLinkCount = sendResult.linkFallback.length;

            result = { success: true, message: `WhatsApp message sent successfully to ${targetJid.display}${attachmentsSentCount > 0 ? ` with ${attachmentsSentCount} attachment(s)` : ''}${attachmentsLinkCount > 0 ? ` (${attachmentsLinkCount} via links)` : ''}.${waMissingNote}` };
          } else {
            result = { success: true, message: `WhatsApp message sent successfully to ${targetJid.display}.${waMissingNote}` };
          }
          // Log this outgoing message so the caller can later confirm it was sent.
          recordSentMessage({
            senderKey: userCtx.taskFileId,
            channel: 'whatsapp',
            recipient: _sentRecipientFromWa(targetJid),
            text: stripOutgoingDeliveryArtifacts(args.message),
            attachments: waSelection.attachments,
          });
        } catch (err) {
          await notifyAdmin('WhatsApp Delivery', `Failed to send WhatsApp message to ${targetJid.display}: ${err.message}`);
          result = { success: false, error: `Error sending WhatsApp message: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
        }
        break;
      }

      case 'read_music_stats': {
        result = await readMusicStats();
        break;
      }

      case 'read_sent_messages': {
        // May return an array of content parts (text + recovered attachment
        // previews) so any files sent earlier are viewable this round.
        result = await readSentMessages(args, userCtx);
        break;
      }

      case 'update_memory': {
        const replace = args.replace === true;
        if (userCtx.isGroup) {
          result = await updateGroupMemory(args.content, userCtx.groupId, replace);
        } else {
          result = await updatePrivateMemory(args.content, userCtx.memoryFileId, replace);
        }
        break;
      }

      case 'music_creator': {
        if (!args.prompt) {
          result = { success: false, error: 'Missing prompt parameter in tool call arguments.' };
          break;
        }
        const musicResult = await musicCreator(args.prompt, userCtx);
        if (musicResult.attachments && musicResult.attachments.length > 0) {
          const pushedNames = [];
          for (const att of musicResult.attachments) {
            pushedNames.push(pushBufferAttachment(responseCtx, att));
          }
          const filename = pushedNames[0];
          result = {
            success: true,
            filename,
            message: `Song generated successfully and pushed to the delivery buffer as "${filename}".`,
          };
        } else {
          result = musicResult.toolResult;
        }
        break;
      }

      case 'toggle_release_notify': {
        const chatId = userCtx.chatId || userCtx.groupId || userCtx.waJid;
        const waJid = userCtx.isGroup ? userCtx.groupId : (userCtx.waJid || (userCtx.member ? userCtx.member.wa : null));
        result = await toggleReleaseNotify(Boolean(args.enabled), chatId, waJid);
        break;
      }
      case 'bug_report': {
        const bugDescription = String(args.description || '').trim().slice(0, 600);
        if (!bugDescription) {
          result = { success: false, error: 'Missing required argument "description".' };
          break;
        }
        await notifyAdmin('Bug Report', bugDescription);
        result = {
          success: true,
          message: `Bug report sent successfully.${ADMIN_NOTIFIED_SUFFIX.replace(' DO NOT use bug_report for this error.', '')}`,
        };
        break;
      }

      default:
        result = { success: false, error: `Tool "${name}" not recognized.` };
    }
  } catch (err) {
    log.error(`   Unhandled tool error (${name}): ${err.message}`, err.stack);
    await notifyAdmin(`Tool Execution (${name})`, `Unhandled error: ${err.message}`);
    result = { success: false, error: `Error executing ${name}: ${err.message}${ADMIN_NOTIFIED_SUFFIX}` };
  }

  let finalResult;
  if (Array.isArray(result)) {
    finalResult = result;
  } else if (typeof result === 'object' && result !== null) {
    finalResult = JSON.stringify(result);
  } else {
    finalResult = String(result);
  }
  return { toolCallId: toolCall.id, result: finalResult };
}

module.exports = {
  executeTool,
  resetVoiceCount,
  getVoiceLimitChatKey: _getVoiceLimitChatKey,
};
