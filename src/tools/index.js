// src/tools/index.js
//
// Central dispatcher for all tool calls from the main brain.
// Responsibilities: permission checks, schema validation via validateToolArgs,
// Per-round tool caps (build/imagine/etc.), recipient resolution
// (for email/wa), the main execution switch, and unified error handling with
// admin notification on uncaught failures. All individual tools are required here.

const { getToolAccessError, validateToolArgs } = require('../ai/tools');
const { generateImage, generateVideo } = require('./imagineGenerator');
const { generateVoice } = require('./voiceMessage');
const { stripOutgoingDeliveryArtifacts } = require('../utils/text');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { readFileTool } = require('./readFile');
const { generateFormalRequestPdf } = require('./formalRequestPdf');
const { sendEmailDirect } = require('./emailSender');
const { sendWhatsAppDirect } = require('./whatsappSender');
const { resolveActiveMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { readMusicStats } = require('./musicStats');
const { updatePrivateMemory } = require('./userMemory');
const { updateGroupMemory } = require('./groupMemory');
const { toggleReleaseNotify } = require('./releaseNotify');
const { buildTool } = require('./build');
const { pushBufferAttachment } = require('../utils/attachments');
const { musicCreator } = require('./musicCreator');
const { getGroupTaskFileId } = require('../utils/userIdentifier');
const { sanitizeFilename } = require('../utils/text');
const { MAX_TTS_CHARS } = require('../config/constants');
const { resolveProfile, toolUnavailableMessage } = require('../config/platformCapabilities');
const { createLogger } = require('../utils/logger');
const { toWhatsAppMediaArgs, toEmailAttachment, attachmentSize } = require('../utils/attachments');
const { sendAttachmentsWithFallback, buildFallbackAttachmentMessage } = require('../utils/attachmentFallback');

const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { resolveDeliverySelection } = require('../utils/deliverySelection');
const { getVoiceCount, incrementVoiceCount, resetVoiceCount } = require('../utils/voiceCounter');
const {
  PER_ROUND_TOOL_LIMITS,
  perRoundCapErrorPayload,
} = require('../utils/toolCallExecution');
const { MessageMedia } = require('whatsapp-web.js');

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

/**
 * Resolve the target WhatsApp JID for delivery.
 * Admin: can target anyone. Active member: can target other members. Otherwise: self.
 */
function _resolveTargetWaJid(args, userCtx) {
  // Extract recipient info (supports nested recipient object or top-level fields)
  const recipientPhone = args.recipient?.phone || args.recipientPhone;
  const recipientName = args.recipient?.name || args.recipientName;

  if (userCtx.isAdmin) {
    if (recipientPhone) {
      const jid = normalizePhoneToJid(recipientPhone);
      return { jid, display: recipientPhone };
    }
    if (recipientName) {
      const resolved = resolveActiveMemberByName(recipientName);
      if (!resolved.ok) return { error: { success: false, error: resolved.error } };
      return { jid: resolved.member.wa, display: resolved.member.name };
    }
    if (userCtx.waJid) {
      return { jid: userCtx.waJid, display: userCtx.userName || 'yourself' };
    }
  } else if (userCtx.isActiveMember && recipientName) {
    const resolved = resolveActiveMemberByName(recipientName);
    if (!resolved.ok) return { error: { success: false, error: resolved.error } };
    return { jid: resolved.member.wa, display: resolved.member.name };
  }
  if (!userCtx.waJid) return { error: { success: false, error: 'No WhatsApp number available.' } };
  return { jid: userCtx.waJid, display: 'yourself' };
}

/**
 * Resolve the target email for delivery.
 * Non-member: blocked. Admin: any email. Active member: other members. Otherwise: self.
 */
function _resolveTargetEmail(args, userCtx) {
  if (!userCtx.isActiveMember) {
    return { error: { success: false, error: 'Only active members can send emails.' } };
  }
  // Extract recipient info (supports nested recipient object or top-level fields)
  const recipientEmail = args.recipient?.email || args.recipientEmail;
  const recipientName = args.recipient?.name || args.recipientName;

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
      isFirstTurn: Boolean(userCtx.isFirstTurn),
    }),
  });
}

/**
 * Execute a tool call and return the result.
 * Validates permissions, executes the tool, and collects responses/attachments.
 * @param {object} toolCall - The tool call from the AI model { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, isGroup, groupId }
 * @param {object} responseCtx - Mutable context for attachments/voice { attachments: [], voiceBuffer: null, isVoiceOnly: false }
 * @param {object} deliveryCtx - Delivery tracking context { contactedWA: Set, contactedEmail: Set, roundToolCounts: Map }
 * @param {Array} [toolDefs] - Optional list of currently-allowed tool definitions, used for early arg validation.
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx, toolDefs = null) {
  const name = toolCall.function.name;
  const chatKey = _getVoiceLimitChatKey(userCtx);

  // Voice limits are reset centrally in handler.js when a text message is sent,
  // preventing the AI from bypassing limits by calling intermediate tools.

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
    if (name === 'send_voice_message' || name === 'music_creator') {
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

      case 'read_file': {
        result = await readFileTool(args.path, userCtx, responseCtx);
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

      case 'send_voice_message': {
        if (!args.text || typeof args.text !== 'string' || args.text.trim().length === 0) {
          result = { success: false, error: 'Missing "text" parameter. You must provide the text to convert to speech.' };
          break;
        }
        let cleanText = stripOutgoingDeliveryArtifacts(
          (args.text || '').replace(/<a?:[\w]+:\d+>/g, '')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, ''),
        );

        const currentCount = await getVoiceCount(userCtx, chatKey);
        if (currentCount >= 3) {
          log.warn(`Voice limit exceeded in chat ${chatKey}: counter=${currentCount}`);
          await resetVoiceCount(userCtx, chatKey);
          result = { success: false, error: 'Voice limit exceeded: you have already sent 3 consecutive voice messages in this chat. Reply with a normal text message instead, no voice.' };
          break;
        }

        if (cleanText.length > MAX_TTS_CHARS) {
          result = { success: false, error: `Text exceeds the ${MAX_TTS_CHARS} character limit (${cleanText.length} chars). Cannot generate a voice message. Reply with a normal text message instead.` };
          break;
        }

        // Files explicitly selected by the model (delivery-buffer names or
        // public URLs). The parameter only exists while deliverables exist.
        const voiceSelection = await resolveDeliverySelection(args.attachments, responseCtx);
        const voiceMissingNote = voiceSelection.missing.length > 0
          ? ` Attachment(s) not resolved and NOT sent: ${voiceSelection.missing.join(', ')}.`
          : '';

        // Send as reply in the current chat
        if (responseCtx.voiceBuffer) {
          return {
            toolCallId: toolCall.id,
            result: JSON.stringify({ success: false, error: 'A voice message has already been generated. You cannot generate another one in the same request.' }),
          };
        }
        const voiceBuffer = await generateVoice(cleanText);
        responseCtx.voiceBuffer = voiceBuffer;
        responseCtx.isVoiceOnly = true;
        // Voice to the current chat ends the turn: only the files selected in
        // `attachments` ship after the voice note.
        responseCtx.attachments = voiceSelection.attachments;
        responseCtx.pendingVoiceTranscript = {
          chatId: userCtx.chatId || chatKey,
          text: cleanText,
        };
        result = {
          success: true,
          message: `Voice message generated successfully${voiceSelection.attachments.length > 0 ? ` with ${voiceSelection.attachments.length} attachment(s)` : ''}. Do not send any text message.${voiceMissingNote}`,
        };
        await incrementVoiceCount(userCtx, chatKey);
        break;
      }

      case 'schedule_tasks': {
        const taskCtx = {
          taskFileId: userCtx.taskFileId,
          groupTaskFileId: userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null,
          userId: userCtx.userId,
          userName: userCtx.userName,
          userPhone: userCtx.userPhone,
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
          result = { success: true, message: `Formal request PDF "${formalFinalName}" generated successfully.` };
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
        // Files explicitly selected by the model (delivery-buffer names or
        // public URLs). The parameter only exists while deliverables exist.
        const emailSelection = await resolveDeliverySelection(args.attachments, responseCtx);
        const emailMissingNote = emailSelection.missing.length > 0
          ? ` Attachment(s) not resolved and NOT sent: ${emailSelection.missing.join(', ')}.`
          : '';
        try {
          // Try to send with fallback support for attachments
          if (emailSelection.attachments.length > 0) {
            // Validation step: separate sent vs failed (link-fallback)
            const sent = [];
            const failed = [];
            for (const att of emailSelection.attachments) {
              const emailAtt = toEmailAttachment(att);
              // Check if valid and not too large for direct email (arbitrary 15MB limit)
              const MAX_EMAIL_ATT_SIZE = 15 * 1024 * 1024;
              const size = attachmentSize(att);

              if (emailAtt && emailAtt.filename && (emailAtt.content || emailAtt.path) && size < MAX_EMAIL_ATT_SIZE) {
                sent.push(emailAtt);
              } else {
                failed.push(att);
              }
            }

            let fallbackMessage = null;
            if (failed.length > 0) {
              try {
                const fallbackData = buildFallbackAttachmentMessage(failed, { platform: 'email' });
                fallbackMessage = fallbackData.message;
              } catch (err) {
                log.error(`Failed to generate email fallback links: ${err.message}`);
                fallbackMessage = `⚠️ Alcuni allegati non hanno potuto essere inclusi direttamente nell'email e non è stato possibile creare link temporanei.`;
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

            result = { success: true, message: `Email sent successfully to ${targetEmail.display}${sent.length > 0 ? ` with ${sent.length} attachment(s)` : ''}${failed.length > 0 ? ` (${failed.length} via temporary links)` : ''}.${emailMissingNote}` };
          } else {
            await sendEmailDirect(
              targetEmail.email,
              stripOutgoingDeliveryArtifacts(args.subject || ''),
              `<div style="font-family:sans-serif">${_escapeHtml(stripOutgoingDeliveryArtifacts(args.body || '')).replace(/\n/g, '<br>')}</div>`,
              []
            );
            result = { success: true, message: `Email sent successfully to ${targetEmail.display}.${emailMissingNote}` };
          }
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

        const waRecipientName = args.recipient?.name || args.recipientName;
        if (waRecipientName) {
          const resolved = resolveActiveMemberByName(waRecipientName);
          if (resolved.ok && resolved.member.wa === userCtx.waJid) {
            result = { success: false, error: 'You cannot send to yourself. To reply in the current chat, omit the recipient.' };
            break;
          }
        }

        const targetJid = _resolveTargetWaJid(args, userCtx);
        if (targetJid.error) { result = targetJid.error; break; }
        if (deliveryCtx.contactedWA.has(targetJid.jid)) {
          result = { success: false, error: `You have already sent a WhatsApp message to this number. Each number can only receive 1 message per request.` };
          break;
        }
        deliveryCtx.contactedWA.add(targetJid.jid);
        // Files explicitly selected by the model (delivery-buffer names or
        // public URLs). The parameter only exists while deliverables exist.
        const waSelection = await resolveDeliverySelection(args.attachments, responseCtx);
        const waMissingNote = waSelection.missing.length > 0
          ? ` Attachment(s) not resolved and NOT sent: ${waSelection.missing.join(', ')}.`
          : '';
        try {
          await sendWhatsAppDirect(targetJid.jid, stripOutgoingDeliveryArtifacts(args.message));
          if (waSelection.attachments.length > 0) {
            // Try to send attachments with fallback support
            const sendAttachment = async (att) => {
              const m = toWhatsAppMediaArgs(att);
              if (!m) {
                throw new Error(`Cannot convert attachment to WhatsApp media: ${att.name || 'unknown'}`);
              }
              const media = new MessageMedia(m.mimetype, m.base64, m.name);
              const options = {};
              if (att.sendAudioAsVoice) options.sendAudioAsVoice = true;
              await sendWhatsAppDirect(targetJid.jid, media, options);
            };

            const sendResult = await sendAttachmentsWithFallback(
              waSelection.attachments,
              sendAttachment,
              { platform: 'whatsapp' }
            );

            log.info(`WhatsApp delivery: ${sendResult.sent.length} sent, ${sendResult.failed.length} failed`);

            // If there are failed attachments, send fallback message
            if (sendResult.fallbackMessage) {
              try {
                await sendWhatsAppDirect(targetJid.jid, sendResult.fallbackMessage);
                log.info(`Sent fallback message for ${sendResult.failed.length} attachment(s)`);
              } catch (err) {
                log.error(`Failed to send fallback message: ${err.message}`);
              }
            }

            const attachmentsSentCount = sendResult.sent.length;
            const attachmentsFailedCount = sendResult.failed.length;

            result = { success: true, message: `WhatsApp message sent successfully to ${targetJid.display}${attachmentsSentCount > 0 ? ` with ${attachmentsSentCount} attachment(s)` : ''}${attachmentsFailedCount > 0 ? ` (${attachmentsFailedCount} via temporary links)` : ''}.${waMissingNote}` };
          } else {
            result = { success: true, message: `WhatsApp message sent successfully to ${targetJid.display}.${waMissingNote}` };
          }
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

      case 'update_memory': {
        if (userCtx.isGroup) {
          result = updateGroupMemory(args.content, userCtx.groupId);
        } else {
          result = updatePrivateMemory(args.content, userCtx.memoryFileId);
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
          for (const att of musicResult.attachments) {
            pushBufferAttachment(responseCtx, att);
          }
        }
        result = musicResult.toolResult;
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
  PER_ROUND_TOOL_LIMITS,
};
