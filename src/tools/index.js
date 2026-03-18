const { isActiveMemberOnlyTool } = require('../ai/tools');
const { webSearch } = require('./webSearch');
const { imageSearch } = require('./imageSearch');
const { generateVoice } = require('./voiceMessage');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { readAboutMe } = require('./aboutMe');
const { generatePdf } = require('./pdfGenerator');
const { sendEmail, sendEmailDirect } = require('./emailSender');
const { sendWhatsAppMessage, sendWhatsAppVoice, sendWhatsAppAttachments, sendWhatsAppDirect } = require('./whatsappSender');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { readMusicStats } = require('./musicStats');
const { getGroupTaskFileId } = require('../utils/userIdentifier');
const { sanitizeFilename } = require('../utils/text');
const { removeDiscordEmoji } = require('../utils/discord');
const { MAX_TTS_CHARS } = require('../config/constants');

/**
 * Resolve the target WhatsApp JID for delivery.
 * Admin: can target anyone. Active member (non-dynamic): can target other members. Otherwise: self.
 */
function _resolveDynamicWaJid(args, userCtx, dynamicTaskCtx) {
  if (userCtx.isAdmin) {
    if (args.recipientPhone) {
      const jid = normalizePhoneToJid(args.recipientPhone);
      return { jid, display: args.recipientPhone };
    }
    if (args.recipientName) {
      const member = findMemberByName(args.recipientName);
      if (!member) return { error: `❌ "${args.recipientName}" non trovato tra i membri attivi. Specifica recipientPhone per non-membri.` };
      return { jid: member.wa, display: member.name };
    }
  } else if (userCtx.isActiveMember && args.recipientName && !dynamicTaskCtx.isDynamic) {
    const member = findMemberByName(args.recipientName);
    if (!member) return { error: `❌ "${args.recipientName}" non trovato tra i membri attivi.` };
    return { jid: member.wa, display: member.name };
  }
  if (!dynamicTaskCtx.creatorJid) return { error: '❌ Nessun numero WhatsApp del creatore disponibile.' };
  return { jid: dynamicTaskCtx.creatorJid, display: 'te stesso' };
}

/**
 * Resolve the target email for delivery.
 * Non-member: blocked. Admin: any email. Active member (non-dynamic): other members. Otherwise: self.
 */
function _resolveDynamicEmail(args, userCtx, dynamicTaskCtx) {
  if (!userCtx.isActiveMember) {
    return { error: '❌ Solo i membri attivi possono inviare email.' };
  }
  if (userCtx.isAdmin) {
    if (args.recipientEmail) {
      return { email: args.recipientEmail, display: args.recipientEmail };
    }
    if (args.recipientName) {
      const member = findMemberByName(args.recipientName);
      if (member && member.email) return { email: member.email, display: member.name };
      return { error: `❌ "${args.recipientName}" non trovato o senza email.` };
    }
  } else if (args.recipientName && !dynamicTaskCtx.isDynamic) {
    const member = findMemberByName(args.recipientName);
    if (member && member.email) return { email: member.email, display: member.name };
    return { error: `❌ "${args.recipientName}" non trovato o senza email.` };
  }
  if (!dynamicTaskCtx.creatorEmail) return { error: '❌ Nessun indirizzo email del creatore disponibile.' };
  return { email: dynamicTaskCtx.creatorEmail, display: 'te stesso' };
}

/**
 * Execute a tool call and return the result.
 * Validates permissions, executes the tool, and collects responses/attachments.
 * @param {object} toolCall - The tool call from Gemini { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, email, isGroup, groupId }
 * @param {object} responseCtx - Mutable context for attachments/voice { attachments: [], voiceBuffer: null, isVoiceOnly: false }
 * @param {object|null} [dynamicTaskCtx=null] - If present, enforces dynamic task delivery rules { contactedWA: Set, contactedEmail: Set, creatorJid, creatorEmail }
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx, dynamicTaskCtx = null) {
  const name = toolCall.function.name;
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    args = {};
  }

  if (isActiveMemberOnlyTool(name) && !userCtx.isActiveMember) {
    return {
      toolCallId: toolCall.id,
      result: `Errore: lo strumento "${name}" è disponibile solo per i membri attivi del server.`,
    };
  }

  let result;

  try {
    switch (name) {
      case 'web_search': {
        result = await webSearch(args.query);
        break;
      }

      case 'image_search': {
        const imageResult = await imageSearch(args.query, args.count);
        
        // Always accumulate images - will be sent by send_whatsapp_message or send_email
        if (Array.isArray(imageResult.attachments) && imageResult.attachments.length > 0) {
          responseCtx.attachments.push(...imageResult.attachments);
        }
        result = imageResult.text;
        break;
      }

      case 'send_voice_message': {
        let cleanText = removeDiscordEmoji(args.text || '').replace(/<a?:[\w]+:\d+>/g, '')
          .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (cleanText.length > MAX_TTS_CHARS) {
          result = `❌ Il testo supera il limite di ${MAX_TTS_CHARS} caratteri (${cleanText.length} caratteri). Non è possibile generare un vocale. Rispondi con un normale messaggio testuale.`;
          break;
        }

        // Delivery to a specific recipient (or dynamic task forced delivery)
        if (dynamicTaskCtx && (args.recipientName || args.recipientPhone || dynamicTaskCtx.isDynamic)) {
          if (args.recipientName && !dynamicTaskCtx.isDynamic) {
            const member = findMemberByName(args.recipientName);
            if (member && member.wa === userCtx.waJid) {
              result = `❌ Non puoi inviare a te stesso. Per rispondere nella chat attuale, ometti recipientName.`;
              break;
            }
          }
          const targetJid = _resolveDynamicWaJid(args, userCtx, dynamicTaskCtx);
          if (targetJid.error) { result = targetJid.error; break; }
          if (dynamicTaskCtx.contactedWA.has(targetJid.jid)) {
            result = `❌ Hai già inviato un messaggio WhatsApp a questo numero. Ogni numero può ricevere solo 1 messaggio per richiesta.`;
            break;
          }
          try {
            const voiceBuf = await generateVoice(cleanText);
            const { MessageMedia } = require('whatsapp-web.js');
            const voiceMedia = new MessageMedia('audio/ogg', voiceBuf.toString('base64'), 'voice.ogg');
            await sendWhatsAppDirect(targetJid.jid, voiceMedia, { sendAudioAsVoice: true });
            // Send accumulated attachments
            if (responseCtx.attachments.length > 0) {
              for (const att of responseCtx.attachments) {
                if (!att.buffer || !att.mimetype) continue;
                const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
                await sendWhatsAppDirect(targetJid.jid, media);
              }
            }
            dynamicTaskCtx.contactedWA.add(targetJid.jid);
            result = `Messaggio vocale inviato con successo a ${targetJid.display}${responseCtx.attachments.length > 0 ? ` con ${responseCtx.attachments.length} allegato/i` : ''}.`;
          } catch (err) {
            result = `Errore invio vocale: ${err.message}`;
          }
          break;
        }

        // Se specificato un destinatario, invia il vocale direttamente a quella persona
        if (args.recipientName || args.recipientPhone) {
          if (!userCtx.isActiveMember) {
            result = 'Errore: solo i membri attivi possono inviare messaggi vocali ad altri.';
            break;
          }
          result = await sendWhatsAppVoice(args.recipientName, cleanText, {
            isAdmin: userCtx.isAdmin,
            recipientPhone: args.recipientPhone,
          });
          break;
        }

        // Altrimenti, invia come risposta nella chat attuale
        if (responseCtx.voiceBuffer) {
          return {
            toolCallId: toolCall.id,
            result: '❌ Errore: un messaggio vocale è già stato generato. Non puoi generarne un altro nella stessa richiesta.',
          };
        }
        const voiceBuffer = await generateVoice(cleanText);
        responseCtx.voiceBuffer = voiceBuffer;
        responseCtx.isVoiceOnly = true;
        result = 'Messaggio vocale generato con successo. Non inviare alcun messaggio testuale.';
        break;
      }

      case 'schedule_tasks': {
        const taskCtx = {
          taskFileId: userCtx.taskFileId,
          groupTaskFileId: userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null,
          userId: userCtx.userId,
          userName: userCtx.userName,
          waJid: userCtx.waJid,
          email: userCtx.member ? userCtx.member.email : null,
          isActiveMember: userCtx.isActiveMember,
          isAdmin: userCtx.isAdmin,
          isGroup: userCtx.isGroup,
          groupId: userCtx.groupId,
        };
        result = scheduleTasks(args.tasks, taskCtx);
        break;
      }

      case 'read_my_tasks': {
        const groupFileId = userCtx.isGroup ? getGroupTaskFileId(userCtx.groupId) : null;
        result = readTasks(userCtx.taskFileId, groupFileId, args.includeGroupTasks);
        break;
      }

      case 'remove_my_tasks': {
        const fileId = args.fromGroup && userCtx.isGroup
          ? getGroupTaskFileId(userCtx.groupId)
          : userCtx.taskFileId;
        result = removeTasks(args.taskIds, fileId);
        break;
      }

      case 'read_server_rules': {
        result = await readServerRules();
        break;
      }

      case 'read_about_me': {
        result = readAboutMe();
        break;
      }

      case 'generate_pdf': {
        const pdfBuffer = await generatePdf(args.title, args.content);
        const fileName = `${sanitizeFilename(args.title || 'documento')}.pdf`;
        const pdfAttachment = {
          name: fileName,
          buffer: pdfBuffer,
          mimetype: 'application/pdf',
        };
        
        // Always accumulate PDF - will be sent by send_whatsapp_message or send_email
        responseCtx.attachments.push(pdfAttachment);
        
        if (dynamicTaskCtx || args.recipientName || args.recipientPhone) {
          result = `PDF "${args.title}" generato con successo. Verrà allegato al prossimo messaggio di consegna.`;
        } else {
          result = `PDF "${args.title}" generato con successo e verrà inviato come allegato.`;
        }
        break;
      }

      case 'send_email': {
        // Dynamic task mode: enforce delivery rules
        if (dynamicTaskCtx) {
          const targetEmail = _resolveDynamicEmail(args, userCtx, dynamicTaskCtx);
          if (targetEmail.error) { result = targetEmail.error; break; }
          if (dynamicTaskCtx.contactedEmail.has(targetEmail.email)) {
            result = `❌ Hai già inviato un'email a questo indirizzo. Ogni email può ricevere solo 1 messaggio per task.`;
            break;
          }
          try {
            // Build nodemailer attachments from responseCtx
            const emailAttachments = responseCtx.attachments
              .map(a => ({ filename: a.name, content: a.buffer, contentType: a.mimetype }));
            await sendEmailDirect(
              targetEmail.email,
              args.subject,
              `<div style="font-family:sans-serif">${(args.body || '').replace(/\n/g, '<br>')}</div>`,
              emailAttachments
            );
            dynamicTaskCtx.contactedEmail.add(targetEmail.email);
            result = `Email inviata con successo a ${targetEmail.display}${emailAttachments.length > 0 ? ` con ${emailAttachments.length} allegato/i` : ''}.`;
          } catch (err) {
            result = `Errore invio email: ${err.message}`;
          }
          break;
        }

        if (!userCtx.isActiveMember) {
          result = 'Errore: solo i membri attivi possono inviare email.';
          break;
        }
        // Check that user is not sending to themselves
        const targetEmailMember = findMemberByName(args.recipientName);
        if (targetEmailMember && targetEmailMember.email === userCtx.email) {
          result = `❌ Non puoi inviare a te stesso. Per rispondere nella chat attuale, non usare questo tool.`;
          break;
        }
        try {
          // Build accumulated attachments from responseCtx
          const accumulatedAttachments = responseCtx.attachments
            .map(a => ({ filename: a.name, content: a.buffer, contentType: a.mimetype }));
          result = await sendEmail(args.recipientName, args.subject, args.body, {
            attachPdf: args.attachPdf,
            pdfTitle: args.pdfTitle,
            pdfContent: args.pdfContent,
            imageUrls: args.imageUrls,
            accumulatedAttachments,
          });
        } catch (err) {
          result = `Errore invio email: ${err.message}`;
        }
        break;
      }

      case 'send_whatsapp_message': {
        // Dynamic task mode: enforce delivery rules
        if (dynamicTaskCtx) {
          const targetJid = _resolveDynamicWaJid(args, userCtx, dynamicTaskCtx);
          if (targetJid.error) { result = targetJid.error; break; }
          if (dynamicTaskCtx.contactedWA.has(targetJid.jid)) {
            result = `❌ Hai già inviato un messaggio WhatsApp a questo numero. Ogni numero può ricevere solo 1 messaggio per task.`;
            break;
          }
          try {
            await sendWhatsAppDirect(targetJid.jid, args.message);
            // Send accumulated attachments
            if (responseCtx.attachments.length > 0) {
              const { MessageMedia } = require('whatsapp-web.js');
              for (const att of responseCtx.attachments) {
                if (!att.buffer || !att.mimetype) continue;
                const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
                await sendWhatsAppDirect(targetJid.jid, media);
              }
            }
            dynamicTaskCtx.contactedWA.add(targetJid.jid);
            result = `Messaggio WhatsApp inviato con successo a ${targetJid.display}${responseCtx.attachments.length > 0 ? ` con ${responseCtx.attachments.length} allegato/i` : ''}.`;
          } catch (err) {
            result = `Errore invio WhatsApp: ${err.message}`;
          }
          break;
        }
        
        if (!userCtx.isActiveMember) {
          result = 'Errore: solo i membri attivi possono inviare messaggi WhatsApp ad altri.';
          break;
        }
        // Check that user is not sending to themselves
        const targetMember = findMemberByName(args.recipientName);
        if (targetMember && targetMember.wa === userCtx.waJid) {
          result = `❌ Non puoi inviare a te stesso. Per rispondere nella chat attuale, non usare questo tool.`;
          break;
        }
        try {
          result = await sendWhatsAppMessage(args.recipientName, args.message, {
            isAdmin: userCtx.isAdmin,
            recipientPhone: args.recipientPhone,
          });
          // Send accumulated attachments if any
          if (responseCtx.attachments.length > 0) {
            const member = findMemberByName(args.recipientName);
            const jid = userCtx.isAdmin && args.recipientPhone 
              ? require('./whatsappSender').normalizePhoneToJid(args.recipientPhone)
              : member?.wa;
            if (jid) {
              const { MessageMedia } = require('whatsapp-web.js');
              for (const att of responseCtx.attachments) {
                if (!att.buffer || !att.mimetype) continue;
                const media = new MessageMedia(att.mimetype, att.buffer.toString('base64'), att.name);
                await sendWhatsAppDirect(jid, media);
              }
              result += ` con ${responseCtx.attachments.length} allegato/i.`;
            }
          }
        } catch (err) {
          result = `Errore invio WhatsApp: ${err.message}`;
        }
        break;
      }

      case 'read_music_stats': {
        result = await readMusicStats();
        break;
      }

      default:
        result = `Strumento "${name}" non riconosciuto.`;
    }
  } catch (err) {
    result = `Errore nell'esecuzione di ${name}: ${err.message}`;
  }

  return { toolCallId: toolCall.id, result: String(result) };
}

module.exports = { executeTool };
