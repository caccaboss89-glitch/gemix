const { isActiveMemberOnlyTool, _markSendAboutMeUsed } = require('../ai/tools');
const { webSearch } = require('./webSearch');
const { imageSearch } = require('./imageSearch');
const { generateVoice, stripVocalTags } = require('./voiceMessage');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { readAboutMe } = require('./aboutMe');
const { generatePdf } = require('./pdfGenerator');
const { sendEmailDirect } = require('./emailSender');
const { sendWhatsAppDirect } = require('./whatsappSender');
const { findMemberByName } = require('../config/members');
const { normalizePhoneToJid } = require('./whatsappSender');
const { extractLastNImages, extractLastNDocs, extractLastNVoices } = require('../utils/media');
const { readMusicStats } = require('./musicStats');
const { updatePrivateMemory } = require('./userMemory');
const { updateGroupMemory } = require('./groupMemory');
const { toggleReleaseNotify } = require('./releaseNotify');
const { getGroupTaskFileId } = require('../utils/userIdentifier');
const { sanitizeFilename } = require('../utils/text');
const { removeDiscordEmoji } = require('../utils/discord');
const { MAX_TTS_CHARS, MAX_HISTORY_IMAGES, MAX_HISTORY_DOCS, MAX_HISTORY_VOICES } = require('../config/constants');
const { createLogger } = require('../utils/logger');
const { storeVoiceText } = require('../utils/voiceTextCache');

const log = createLogger('Tools');

// Tracking consecutive voice usage per WhatsApp chat (with TTL cleanup)
const voiceConsecutiveByChat = new Map();
const VOICE_COUNT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic auto-cleanup: removes stale entries even if no voice message is sent
setInterval(_cleanupVoiceCounts, VOICE_COUNT_TTL_MS).unref();

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
    .replace(/"/g, '&quot;');
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
      if (!member) return { error: `❌ "${recipientName}" non trovato tra i membri attivi. Specifica il telefono per non-membri.` };
      return { jid: member.wa, display: member.name };
    }
    if (userCtx.userPhone) {
      const jid = normalizePhoneToJid(userCtx.userPhone);
      return { jid, display: userCtx.userName || userCtx.userPhone };
    }
  } else if (userCtx.isActiveMember && recipientName) {
    const member = findMemberByName(recipientName);
    if (!member) return { error: `❌ "${recipientName}" non trovato tra i membri attivi.` };
    return { jid: member.wa, display: member.name };
  }
  if (!userCtx.waJid) return { error: '❌ Nessun numero WhatsApp disponibile.' };
  return { jid: userCtx.waJid, display: 'te stesso' };
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
    return { error: '❌ Solo i membri attivi possono inviare email.' };
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
      return { error: `❌ "${recipientName}" non trovato o senza email.` };
    }
  } else if (recipientName) {
    const member = findMemberByName(recipientName);
    if (member && member.email) return { email: member.email, display: member.name };
    return { error: `❌ "${recipientName}" non trovato o senza email.` };
  }
  if (!userCtx.email) return { error: '❌ Nessun indirizzo email disponibile.' };
  return { email: userCtx.email, display: 'te stesso' };
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
      result: `❌ Errore: lo strumento "${name}" è disponibile solo per i membri attivi del server.`,
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

      case 'include_history_images': {
        let count = Number(args.count || 0);
        if (!Number.isInteger(count) || count <= 0) {
          result = '❌ count deve essere un intero positivo.';
          break;
        }

        if (count > MAX_HISTORY_IMAGES) count = MAX_HISTORY_IMAGES;

        const images = extractLastNImages(userCtx.historyFull || [], count);

        if (!images || images.length === 0) {
          result = '❌ Non ci sono immagini nella cronologia da includere.';
          break;
        }

        responseCtx.historyImagesToInclude = images;
        result = `✅ Includo le ultime ${images.length} immagine/i nella prossima chiamata API.`;
        break;
      }

      case 'include_history_docs': {
        let count = Number(args.count || 0);
        if (!Number.isInteger(count) || count <= 0) {
          result = '❌ count deve essere un intero positivo.';
          break;
        }

        if (count > MAX_HISTORY_DOCS) count = MAX_HISTORY_DOCS;

        const docs = extractLastNDocs(userCtx.historyFull || [], count);

        if (!docs || docs.length === 0) {
          result = '❌ Non ci sono documenti nella cronologia da includere.';
          break;
        }

        responseCtx.historyDocsToInclude = docs;
        result = `✅ Includo gli ultimi ${docs.length} documento/i nella prossima chiamata API.`;
        break;
      }

      case 'include_history_voices': {
        let count = Number(args.count || 0);
        if (!Number.isInteger(count) || count <= 0) {
          result = '❌ count deve essere un intero positivo.';
          break;
        }

        if (count > MAX_HISTORY_VOICES) count = MAX_HISTORY_VOICES;

        const voices = extractLastNVoices(userCtx.historyFull || [], count);

        if (!voices || voices.length === 0) {
          result = '❌ Non ci sono vocali degli utenti nella cronologia da includere.';
          break;
        }

        responseCtx.historyVoicesToInclude = voices;
        result = `✅ Includo gli ultimi ${voices.length} vocale/i nella prossima chiamata API.`;
        break;
      }

      case 'send_voice_message': {
        let cleanText = removeDiscordEmoji(args.text || '').replace(/<a?:[\w]+:\d+>/g, '')
          .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        const currentCount = _getVoiceCount(chatKey);
        if (currentCount >= 3) {
          log.warn(`Limite vocali WA superato in chat ${chatKey}: counter=${currentCount}`);
          _resetVoiceCount(chatKey);
          result = '❌ Limite vocali superato: in questa chat hai già inviato 3 messaggi vocali consecutivi. Rispondi con un messaggio testuale normale, senza vocali.';
          break;
        }

        if (cleanText.length > MAX_TTS_CHARS) {
          result = `❌ Il testo supera il limite di ${MAX_TTS_CHARS} caratteri (${cleanText.length} caratteri). Non è possibile generare un vocale. Rispondi con un normale messaggio testuale.`;
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
              result = `❌ Non puoi inviare a te stesso. Per rispondere nella chat attuale, ometti il destinatario.`;
              break;
            }
          }
          const targetJid = _resolveTargetWaJid(args, userCtx);
          if (targetJid.error) { result = targetJid.error; break; }
          if (deliveryCtx.contactedWA.has(targetJid.jid)) {
            result = `❌ Hai già inviato un messaggio WhatsApp a questo numero. Ogni numero può ricevere solo 1 messaggio per richiesta.`;
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
            result = `Messaggio vocale inviato con successo a ${targetJid.display}${attachmentsSentCount > 0 ? ` con ${attachmentsSentCount} allegato/i` : ''}.`;
            _incrementVoiceCount(chatKey);
            storeVoiceText(targetJid.jid, stripVocalTags(cleanText));
          } catch (err) {
            result = `❌ Errore invio vocale: ${err.message}`;
          }
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
          result = '⚠️ includeGroupTasks non disponibile: solo in gruppo WhatsApp.';
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
          result = '⚠️ fromGroup non disponibile: solo in gruppo WhatsApp. Operazione sui task personali.';
          break;
        }
        result = await removeTasks(args.taskIds, fileId);
        break;
      }

      case 'read_server_rules': {
        result = await readServerRules();
        break;
      }

      case 'send_about_me': {
        const aboutMeContent = readAboutMe();
        responseCtx.aboutMeText = aboutMeContent;
        responseCtx.isAboutMeOnly = true;
        result = 'Messaggio inviato all\'utente.';

        // One-shot per chat: non mostrare più send_about_me nella lista strumenti.
        const chatKey = userCtx.chatId || userCtx.groupId || userCtx.waJid || userCtx.userId || 'unknown';
        _markSendAboutMeUsed(chatKey);

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

        result = `PDF "${args.title}" generato con successo. Verrà allegato al prossimo messaggio di consegna.`;
        break;
      }

      case 'send_email': {
        const includeAttachments = args.includeAttachments !== false;
        const targetEmail = _resolveTargetEmail(args, userCtx);
        if (targetEmail.error) { result = targetEmail.error; break; }
        if (deliveryCtx.contactedEmail.has(targetEmail.email)) {
          result = `❌ Hai già inviato un'email a questo indirizzo. Ogni email può ricevere solo 1 messaggio per richiesta.`;
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
          result = `Email inviata con successo a ${targetEmail.display}${emailAttachments.length > 0 ? ` con ${emailAttachments.length} allegato/i` : ''}.`;
        } catch (err) {
          result = `❌ Errore invio email: ${err.message}`;
        }
        break;
      }

      case 'send_whatsapp_message': {
        const includeAttachments = args.includeAttachments !== false;

        const targetJid = _resolveTargetWaJid(args, userCtx);
        if (targetJid.error) { result = targetJid.error; break; }
        if (deliveryCtx.contactedWA.has(targetJid.jid)) {
          result = `❌ Hai già inviato un messaggio WhatsApp a questo numero. Ogni numero può ricevere solo 1 messaggio per richiesta.`;
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
          result = `Messaggio WhatsApp inviato con successo a ${targetJid.display}${attachmentsSentCount > 0 ? ` con ${attachmentsSentCount} allegato/i` : ''}.`;
        } catch (err) {
          result = `❌ Errore invio WhatsApp: ${err.message}`;
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
        result = `Strumento "${name}" non riconosciuto.`;
    }
  } catch (err) {
    result = `❌ Errore nell'esecuzione di ${name}: ${err.message}`;
  }

  return { toolCallId: toolCall.id, result: String(result) };
}

module.exports = { executeTool };
