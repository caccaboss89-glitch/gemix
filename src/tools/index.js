// src/tools/index.js
const { isActiveMemberOnlyTool } = require('../ai/tools');
const { webSearch } = require('./webSearch');
const { browsePage } = require('./browsePage');
const { imageSearch } = require('./imageSearch');
const { generateVoice, stripVocalTags } = require('./voiceMessage');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { readFileTool } = require('./readFile');
const { generateFormalRequestPdf } = require('./formalRequestPdf');
const { sendEmailDirect } = require('./emailSender');
const { sendWhatsAppDirect } = require('./whatsappSender');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { readMusicStats } = require('./musicStats');
const { updatePrivateMemory } = require('./userMemory');
const { updateGroupMemory } = require('./groupMemory');
const { toggleReleaseNotify } = require('./releaseNotify');
const { getGroupTaskFileId } = require('../utils/userIdentifier');
const { sanitizeFilename } = require('../utils/text');
const { removeDiscordEmoji } = require('../utils/discord');
const { MAX_TTS_CHARS } = require('../config/constants');
const { createLogger } = require('../utils/logger');
const { storeVoiceText } = require('../utils/voiceTextCache');

const log = createLogger('Tools');

// Tracking consecutive voice usage per WhatsApp chat (with TTL cleanup)
const voiceConsecutiveByChat = new Map();
const VOICE_COUNT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic auto-cleanup: removes stale entries even if no voice message is sent
const voiceCountCleanupInterval = setInterval(_cleanupVoiceCounts, VOICE_COUNT_TTL_MS);
voiceCountCleanupInterval.unref();

function _cleanupVoiceCounts() {
  const cutoff = Date.now() - VOICE_COUNT_TTL_MS;
  for (const [key, entry] of voiceConsecutiveByChat) {
    if (entry.ts < cutoff) voiceConsecutiveByChat.delete(key);
  }
}

function _getVoiceCount(chatKey) {
  const entry = voiceConsecutiveByChat.get(chatKey);
  if (!entry) return 0;
  if (Date.now() - entry.ts > VOICE_COUNT_TTL_MS) {
    voiceConsecutiveByChat.delete(chatKey);
    return 0;
  }
  return entry.count;
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
  // Extract recipient info (can be nested in recipient object or flat for backward compatibility)
  const recipientPhone = args.recipient?.phone || args.recipientPhone;
  const recipientName = args.recipient?.name || args.recipientName;

  if (userCtx.isAdmin) {
    if (recipientPhone) {
      const jid = normalizePhoneToJid(recipientPhone);
      return { jid, display: recipientPhone };
    }
    if (recipientName) {
      const member = findMemberByName(recipientName);
      if (!member) return { error: { success: false, error: `"${recipientName}" not found among active members. Specify a phone number for non-members.` } };
      return { jid: member.wa, display: member.name };
    }
    if (userCtx.userPhone) {
      const jid = normalizePhoneToJid(userCtx.userPhone);
      return { jid, display: userCtx.userName || userCtx.userPhone };
    }
  } else if (userCtx.isActiveMember && recipientName) {
    const member = findMemberByName(recipientName);
    if (!member) return { error: { success: false, error: `"${recipientName}" not found among active members.` } };
    return { jid: member.wa, display: member.name };
  }
  if (!userCtx.waJid) return { error: { success: false, error: 'No WhatsApp number available.' } };
  return { jid: userCtx.waJid, display: 'yourself' };
}

function _getVoiceLimitChatKey(userCtx) {
  return userCtx?.chatId || userCtx?.groupId || userCtx?.waJid || userCtx?.userId || 'unknown';
}

function _incrementVoiceCount(chatKey) {
  const entry = voiceConsecutiveByChat.get(chatKey);
  const count = entry ? entry.count + 1 : 1;
  voiceConsecutiveByChat.set(chatKey, { count, ts: Date.now() });
  if (voiceConsecutiveByChat.size > 500) _cleanupVoiceCounts();
}

function _resetVoiceCount(chatKey) {
  voiceConsecutiveByChat.delete(chatKey);
}

/**
 * Resolve the target email for delivery.
 * Non-member: blocked. Admin: any email. Active member: other members. Otherwise: self.
 */
function _resolveTargetEmail(args, userCtx) {
  if (!userCtx.isActiveMember) {
    return { error: { success: false, error: 'Only active members can send emails.' } };
  }
  // Extract recipient info (can be nested in recipient object or flat for backward compatibility)
  const recipientEmail = args.recipient?.email || args.recipientEmail;
  const recipientName = args.recipient?.name || args.recipientName;

  if (userCtx.isAdmin) {
    if (recipientEmail) {
      return { email: recipientEmail, display: recipientEmail };
    }
    if (recipientName) {
      const member = findMemberByName(recipientName);
      if (member && member.email) return { email: member.email, display: member.name };
      return { error: { success: false, error: `"${recipientName}" not found or has no email.` } };
    }
  } else if (recipientName) {
    const member = findMemberByName(recipientName);
    if (member && member.email) return { email: member.email, display: member.name };
    return { error: { success: false, error: `"${recipientName}" not found or has no email.` } };
  }
  if (!userCtx.email) return { error: { success: false, error: 'No email address available.' } };
  return { email: userCtx.email, display: 'yourself' };
}

/**
 * Execute a tool call and return the result.
 * Validates permissions, executes the tool, and collects responses/attachments.
 * @param {object} toolCall - The tool call from the AI model { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, isGroup, groupId }
 * @param {object} responseCtx - Mutable context for attachments/voice { attachments: [], voiceBuffer: null, isVoiceOnly: false }
 * @param {object} deliveryCtx - Delivery tracking context { contactedWA: Set, contactedEmail: Set }
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx, deliveryCtx) {
  const name = toolCall.function.name;
  const chatKey = _getVoiceLimitChatKey(userCtx);

  // Reset consecutive voice counter on any non-voice tool call
  if (name !== 'send_voice_message') {
    _resetVoiceCount(chatKey);
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    args = {};
  }

  if (isActiveMemberOnlyTool(name) && !userCtx.isActiveMember) {
    return {
      toolCallId: toolCall.id,
      result: JSON.stringify({ success: false, error: `Tool "${name}" is only available for active server members.` }),
    };
  }

  let result;

  try {
    switch (name) {
      case 'web_search': {
        result = await webSearch(args.query, args.num_results, args.allowed_domains, args.excluded_domains);
        break;
      }

      case 'browse_page': {
        result = await browsePage(args.url, args.instructions, args.mode);
        break;
      }

      case 'image_search': {
        // Handle discards first — remove previously buffered images by their global ID
        if (Array.isArray(args.discard) && args.discard.length > 0) {
          const discardSet = new Set(args.discard);
          const before = responseCtx.attachments.length;
          responseCtx.attachments = responseCtx.attachments.filter(
            a => !a._imageSearchId || !discardSet.has(a._imageSearchId)
          );
          const removed = before - responseCtx.attachments.length;
          if (removed > 0) log.info(`   🗑️ Scartate ${removed} immagini: [${[...discardSet].join(', ')}]`);
        }

        const startId = responseCtx.imageSearchNextId || 1;
        const imageResult = await imageSearch(
          args.query,
          args.count,
          {
            language: args.language,
            image_type: args.image_type,
            _startId: startId,
          }
        );

        // Tag each attachment with a global ID and accumulate into delivery buffer
        if (Array.isArray(imageResult.attachments) && imageResult.attachments.length > 0) {
          for (let i = 0; i < imageResult.attachments.length; i++) {
            imageResult.attachments[i]._imageSearchId = startId + i;
            responseCtx.attachments.push(imageResult.attachments[i]);
          }
          responseCtx.imageSearchNextId = startId + imageResult.attachments.length;
        }

        result = imageResult.toolResult;
        break;
      }

      case 'read_file': {
        result = await readFileTool(args.path, userCtx, responseCtx);
        break;
      }

      case 'send_voice_message': {
        let cleanText = removeDiscordEmoji(args.text || '').replace(/<a?:[\w]+:\d+>/g, '')
          .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
          .replace(/<Transcription>.*?<\/Transcription>/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        const currentCount = _getVoiceCount(chatKey);
        if (currentCount >= 3) {
          log.warn(`Voice limit exceeded in chat ${chatKey}: counter=${currentCount}`);
          _resetVoiceCount(chatKey);
          result = { success: false, error: 'Voice limit exceeded: you have already sent 3 consecutive voice messages in this chat. Reply with a normal text message instead, no voice.' };
          break;
        }

        if (cleanText.length > MAX_TTS_CHARS) {
          result = { success: false, error: `Text exceeds the ${MAX_TTS_CHARS} character limit (${cleanText.length} chars). Cannot generate a voice message. Reply with a normal text message instead.` };
          break;
        }

        // Delivery to a specific recipient
        const hasRecipient = args.recipient?.name || args.recipient?.phone || args.recipientName || args.recipientPhone;
        if (hasRecipient) {
          const includeAttachments = args.includeAttachments !== false;

          const recipientName = args.recipient?.name || args.recipientName;
          if (recipientName) {
            const member = findMemberByName(recipientName);
            if (member && member.wa === userCtx.waJid) {
              result = { success: false, error: `You cannot send to yourself. To reply in the current chat, omit the recipient.` };
              break;
            }
          }
          const targetJid = _resolveTargetWaJid(args, userCtx);
          if (targetJid.error) { result = targetJid.error; break; }
          if (deliveryCtx.contactedWA.has(targetJid.jid)) {
            result = { success: false, error: `You have already sent a WhatsApp message to this number. Each number can only receive 1 message per request.` };
            break;
          }
          try {
            const voiceBuf = await generateVoice(cleanText);
            const { MessageMedia } = require('whatsapp-web.js');
            const voiceMedia = new MessageMedia('audio/ogg', voiceBuf.toString('base64'), 'voice.ogg');
            await sendWhatsAppDirect(targetJid.jid, voiceMedia, { sendAudioAsVoice: true });

            // Send accumulated attachments
            if (includeAttachments && responseCtx.attachments.length > 0) {
              for (const att of responseCtx.attachments) {
                if (!att.buffer || !att.mimetype) continue;
                const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
                await sendWhatsAppDirect(targetJid.jid, media);
              }
            }

            const attachmentsSentCount = includeAttachments ? responseCtx.attachments.length : 0;

            deliveryCtx.contactedWA.add(targetJid.jid);
            result = `Voice message sent successfully to ${targetJid.display}${attachmentsSentCount > 0 ? ` with ${attachmentsSentCount} attachment(s)` : ''}.`;
            _incrementVoiceCount(chatKey);
            storeVoiceText(targetJid.jid, stripVocalTags(cleanText));
          } catch (err) {
            result = { success: false, error: `Error sending voice message: ${err.message}` };
          }
          break;
        }

        // Otherwise, send as reply in the current chat
        if (responseCtx.voiceBuffer) {
          return {
            toolCallId: toolCall.id,
            result: JSON.stringify({ success: false, error: 'A voice message has already been generated. You cannot generate another one in the same request.' }),
          };
        }
        const voiceBuffer = await generateVoice(cleanText);
        responseCtx.voiceBuffer = voiceBuffer;
        responseCtx.isVoiceOnly = true;
        result = 'Voice message generated successfully. Do not send any text message.';
        _incrementVoiceCount(chatKey);
        storeVoiceText(userCtx.chatId || chatKey, stripVocalTags(cleanText));
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
        const fileId = args.fromGroup && allowGroup
          ? getGroupTaskFileId(userCtx.groupId)
          : userCtx.taskFileId;
        if (args.fromGroup && !allowGroup) {
          log.info('   fromGroup not available outside WhatsApp groups, falling back to personal tasks');
        }
        result = await removeTasks(args.taskIds, fileId);
        break;
      }

      case 'read_server_rules': {
        result = await readServerRules();
        break;
      }

      case 'generate_formal_request_pdf': {
        const formalPdfBuffer = await generateFormalRequestPdf({
          fullName: args.fullName,
          title: args.title,
          motivation: args.motivation,
          requesterSignature: args.requesterSignature,
          legalSignature: args.legalSignature,
        });
        const formalFileName = `Richiesta_${sanitizeFilename(args.title || 'formale')}.pdf`;
        responseCtx.attachments.push({
          name: formalFileName,
          buffer: formalPdfBuffer,
          mimetype: 'application/pdf',
        });
        result = `Formal request PDF "${args.title}" generated successfully.`;
        break;
      }

      case 'send_email': {
        const includeAttachments = args.includeAttachments !== false;
        const targetEmail = _resolveTargetEmail(args, userCtx);
        if (targetEmail.error) { result = targetEmail.error; break; }
        if (deliveryCtx.contactedEmail.has(targetEmail.email)) {
          result = { success: false, error: `You have already sent an email to this address. Each email can only receive 1 message per request.` };
          break;
        }
        try {
          const emailAttachments = includeAttachments
            ? responseCtx.attachments.map(a => ({ filename: a.name, content: a.buffer, contentType: a.mimetype }))
            : [];
          await sendEmailDirect(
            targetEmail.email,
            args.subject,
            `<div style="font-family:sans-serif">${_escapeHtml(args.body || '').replace(/\n/g, '<br>')}</div>`,
            emailAttachments
          );
          deliveryCtx.contactedEmail.add(targetEmail.email);
          result = `Email sent successfully to ${targetEmail.display}${emailAttachments.length > 0 ? ` with ${emailAttachments.length} attachment(s)` : ''}.`;
        } catch (err) {
          result = { success: false, error: `Error sending email: ${err.message}` };
        }
        break;
      }

      case 'send_whatsapp_message': {
        const includeAttachments = args.includeAttachments !== false;

        const waRecipientName = args.recipient?.name || args.recipientName;
        if (waRecipientName) {
          const member = findMemberByName(waRecipientName);
          if (member && member.wa === userCtx.waJid) {
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
        try {
          await sendWhatsAppDirect(targetJid.jid, args.message);
          if (includeAttachments && responseCtx.attachments.length > 0) {
            const { MessageMedia } = require('whatsapp-web.js');
            for (const att of responseCtx.attachments) {
              if (!att.buffer || !att.mimetype) continue;
              const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
              await sendWhatsAppDirect(targetJid.jid, media);
            }
          }

          const attachmentsSentCount = includeAttachments ? responseCtx.attachments.length : 0;

          deliveryCtx.contactedWA.add(targetJid.jid);
          result = `WhatsApp message sent successfully to ${targetJid.display}${attachmentsSentCount > 0 ? ` with ${attachmentsSentCount} attachment(s)` : ''}.`;
        } catch (err) {
          result = { success: false, error: `Error sending WhatsApp message: ${err.message}` };
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

      case 'toggle_release_notify': {
        const chatId = userCtx.chatId || userCtx.groupId || userCtx.waJid;
        const waJid = userCtx.isGroup ? userCtx.groupId : (userCtx.waJid || (userCtx.member ? userCtx.member.wa : null));
        result = toggleReleaseNotify(Boolean(args.enabled), chatId, waJid);
        break;
      }



      default:
        result = { success: false, error: `Tool "${name}" not recognized.` };
    }
  } catch (err) {
    result = { success: false, error: `Error executing ${name}: ${err.message}` };
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

module.exports = { executeTool };
