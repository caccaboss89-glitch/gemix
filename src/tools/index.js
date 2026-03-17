const { isActiveMemberOnlyTool } = require('../ai/tools');
const { webSearch } = require('./webSearch');
const { imageSearch } = require('./imageSearch');
const { generateVoice, MAX_TTS_CHARS } = require('./voiceMessage');
const { scheduleTasks } = require('./scheduler');
const { readTasks } = require('./taskReader');
const { removeTasks } = require('./taskRemover');
const { readServerRules } = require('./serverRules');
const { generatePdf } = require('./pdfGenerator');
const { sendEmail } = require('./emailSender');
const { sendWhatsAppMessage } = require('./whatsappSender');
const { getGroupTaskFileId } = require('../utils/userIdentifier');

/**
 * Execute a tool call and return the result.
 * Validates permissions, executes the tool, and collects responses/attachments.
 * @param {object} toolCall - The tool call from Gemini { id, function: { name, arguments } }
 * @param {object} userCtx - User context { isActiveMember, isAdmin, member, taskFileId, userId, userName, waJid, email, isGroup, groupId }
 * @param {object} responseCtx - Mutable context for attachments/voice { attachments: [], voiceBuffer: null, isVoiceOnly: false }
 * @returns {Promise<object>} { toolCallId: string, result: string }
 */
async function executeTool(toolCall, userCtx, responseCtx) {
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
        if (Array.isArray(imageResult.attachments) && imageResult.attachments.length > 0) {
          responseCtx.attachments.push(...imageResult.attachments);
        }
        result = imageResult.text;
        break;
      }

      case 'send_voice_message': {
        if (responseCtx.voiceBuffer) {
          return {
            toolCallId: toolCall.id,
            result: '❌ Errore: un messaggio vocale è già stato generato. Non puoi generarne un altro nella stessa richiesta.',
          };
        }
        let cleanText = (args.text || '')
          .replace(/<a?:[\w]+:\d+>/g, '')
          .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (cleanText.length > MAX_TTS_CHARS) {
          result = `❌ Il testo supera il limite di ${MAX_TTS_CHARS} caratteri (${cleanText.length} caratteri). Non è possibile generare un vocale. Rispondi con un normale messaggio testuale.`;
          break;
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

      case 'generate_pdf': {
        const pdfBuffer = await generatePdf(args.title, args.content);
        const fileName = `${(args.title || 'documento').replace(/[^a-zA-Z0-9àèéìòù\s]/gi, '').replace(/\s+/g, '_')}.pdf`;
        responseCtx.attachments.push({
          name: fileName,
          buffer: pdfBuffer,
          mimetype: 'application/pdf',
        });
        result = `PDF "${args.title}" generato con successo e verrà inviato come allegato.`;
        break;
      }

      case 'send_email': {
        if (!userCtx.isActiveMember) {
          result = 'Errore: solo i membri attivi possono inviare email.';
          break;
        }
        result = await sendEmail(args.recipientName, args.subject, args.body, {
          attachPdf: args.attachPdf,
          pdfTitle: args.pdfTitle,
          pdfContent: args.pdfContent,
        });
        break;
      }

      case 'send_whatsapp_message': {
        if (!userCtx.isActiveMember) {
          result = 'Errore: solo i membri attivi possono inviare messaggi WhatsApp ad altri.';
          break;
        }
        result = await sendWhatsAppMessage(args.recipientName, args.message, {
          isAdmin: userCtx.isAdmin,
          recipientPhone: args.recipientPhone,
        });
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
