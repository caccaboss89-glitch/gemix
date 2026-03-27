const { callGemini, buildDiscordResponseFormat } = require('./ai/gemini');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser, getToolInstructions } = require('./ai/tools');
const { executeTool } = require('./tools');
const { isAdmin } = require('./config/members');
const { MAX_TOOL_ROUNDS, PLATFORM_DISCORD } = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { hasHistoryImages, limitHistoryMediaAttachments, extractLastNImages } = require('./utils/media');

const log = createLogger('Handler');

function removeToolInstructionMessages(messages) {
  return messages.filter(m => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return true;
    return !m.content.startsWith('ISTRUZIONI per lo strumento');
  });
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * Processes the message through Gemini AI with tool calls and multimodal content support.
 * @param {object} ctx - Normalized message context { platform, userId, userName, userIdentity, content, history, isGroup, groupId, ... }
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, discordTitle?, discordMessage? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    attachments: [],
    voiceBuffer: null,
    isVoiceOnly: false,
    aboutMeText: null,
    isAboutMeOnly: false,
    historyImagesToInclude: [],
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;

    const systemPrompt = buildSystemPrompt(ctx);

    const userCtx = {
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      userPhone: ctx.userPhone || null,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
      chatId: ctx.chatId || null,
      platform: ctx.platform,
      hasHistoryImages,
      historyFull: ctx.history || [],
    };

    const tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    let messages = [
      { role: 'system', content: systemPrompt },
    ];

    const historyHasImages = hasHistoryImages(ctx.history);
    const filteredHistory = ctx.history && ctx.history.length > 0
      ? limitHistoryMediaAttachments(JSON.parse(JSON.stringify(ctx.history)), 0, 3)
      : [];

    if (filteredHistory.length > 0) {
      const historyLines = [];
      const userMultimodalEntries = [];

      for (const h of filteredHistory) {
        if (typeof h.content === 'string') {
          historyLines.push(h.content);
        } else if (Array.isArray(h.content)) {
          const textPart = h.content.find(p => p.type === 'text');
          const mediaParts = h.content.filter(p => p.type !== 'text');
          const textLine = textPart ? textPart.text : '[media]';
          historyLines.push(textLine);

          if (mediaParts.length > 0) {
            const label = h.role === 'assistant'
              ? `[File dalla cronologia inviato da GemiX: ${textLine}]`
              : (textPart ? textPart.text : '[File dalla cronologia]');
            userMultimodalEntries.push({
              role: 'user',
              content: [
                { type: 'text', text: label },
                ...mediaParts,
              ],
            });
          }
        }
      }

      messages.push({
        role: 'user',
        content: `[CRONOLOGIA ULTIMI MESSAGGI]\n${historyLines.join('\n')}\n[FINE CRONOLOGIA]`,
      });

      for (const entry of userMultimodalEntries) {
        messages.push(entry);
      }

      messages.push({
        role: 'user',
        content: 'Rispondi al seguente messaggio:',
      });
    }

    messages.push({ role: 'user', content: ctx.content });


    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set(),
      creatorJid: userCtx.waJid,
      creatorEmail: userCtx.email,
      isDynamic: false,
    };

    let rounds = 0;
    const isDiscord = ctx.platform === PLATFORM_DISCORD;

    while (rounds < MAX_TOOL_ROUNDS) {
      messages = removeToolInstructionMessages(messages);
      rounds++;

      if (responseCtx.historyImagesToInclude && responseCtx.historyImagesToInclude.length > 0) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: `[Richiesta immagini cronologia]` },
            ...responseCtx.historyImagesToInclude,
          ],
        });
        responseCtx.historyImagesToInclude = [];
      }
      
      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   ⚠️ Vocale già generato, interruzione ciclo`);
        break;
      }
      
      if (responseCtx.isAboutMeOnly && responseCtx.aboutMeText) {
        log.warn(`   ⚠️ Testo 'Chi sono' già preparato, interruzione ciclo`);
        break;
      }
      
      const responseFormat = isDiscord ? buildDiscordResponseFormat(ctx.threadName || '') : null;

      const roundTools = (responseCtx.attachments && responseCtx.attachments.length > 0)
        ? tools
        : tools.filter(t => t.function.name !== 'clear_attachments');

      log.info(`🤖 [${ctx.platform.toUpperCase()}] Chiamata Gemini (round ${rounds}/${MAX_TOOL_ROUNDS})`);
      const assistantMsg = await callGemini(messages, roundTools, responseFormat);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          assistantMsg.content = '';
        }
        messages.push(assistantMsg);

        for (const tc of assistantMsg.tool_calls) {
          const toolName = tc.function.name;
          const toolInstr = getToolInstructions(toolName);
          messages = removeToolInstructionMessages(messages);
          if (toolInstr && toolInstr.trim() !== '') {
            messages.push({
              role: 'assistant',
              content: `ISTRUZIONI per lo strumento ${toolName}: ${toolInstr}`,
            });
          }
          try {
            log.info(`   Esecuzione: ${tc.function.name}`);
            const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx);
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: result,
            });
          } catch (toolErr) {
            log.error(`   ❌ Errore tool "${tc.function.name}": ${toolErr.message}`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Errore esecuzione: ${toolErr.message}`,
            });
          }
        }

        continue;
      }

      let text = assistantMsg.content || '';
      log.info(`✅ [${ctx.platform.toUpperCase()}] Risposta generata (${text.length} caratteri)`);

      if (responseCtx.isAboutMeOnly && responseCtx.aboutMeText) {
        log.info(`   📖 Testo 'Chi sono' pronto (${responseCtx.aboutMeText.length} caratteri)`);
        return {
          text: responseCtx.aboutMeText,
          voiceBuffer: null,
          isVoiceOnly: false,
          isAboutMeOnly: true,
          attachments: responseCtx.attachments,
        };
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.info(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
        let discordTitle = '';
        if (isDiscord && text) {
          try { discordTitle = JSON.parse(text).title || ''; } catch {}
        }
        return {
          text: null,
          voiceBuffer: responseCtx.voiceBuffer,
          isVoiceOnly: true,
          attachments: responseCtx.attachments,
          discordTitle,
        };
      }

      if (isDiscord && text) {
        try {
          const parsed = JSON.parse(text);
          return {
            text: null,
            voiceBuffer: null,
            isVoiceOnly: false,
            attachments: responseCtx.attachments,
            discordTitle: parsed.title || '',
            discordMessage: parsed.message || '',
          };
        } catch {
          // Fallback: treat as plain text
          return {
            text,
            voiceBuffer: null,
            isVoiceOnly: false,
            attachments: responseCtx.attachments,
            discordTitle: '',
            discordMessage: text,
          };
        }
      }

      if (responseCtx.isVoiceOnly) {
        return {
          text: null,
          voiceBuffer: responseCtx.voiceBuffer,
          isVoiceOnly: true,
          attachments: responseCtx.attachments,
        };
      }

      return {
        text: text || null,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: responseCtx.attachments,
      };
    }

    if (responseCtx.isAboutMeOnly && responseCtx.aboutMeText) {
      log.info(`   📖 Testo 'Chi sono' pronto (${responseCtx.aboutMeText.length} caratteri)`);
      return {
        text: responseCtx.aboutMeText,
        voiceBuffer: null,
        isVoiceOnly: false,
        isAboutMeOnly: true,
        attachments: responseCtx.attachments,
      };
    }

    if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
      log.info(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
      return {
        text: null,
        voiceBuffer: responseCtx.voiceBuffer,
        isVoiceOnly: true,
        attachments: responseCtx.attachments,
      };
    }

    return {
      text: 'Mi dispiace, ho incontrato un problema elaborando la tua richiesta. Riprova.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
    };

  } catch (err) {
    log.error(`\n❌ [${ctx.platform.toUpperCase().padEnd(10)}] ERRORE nel handler:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    return {
      text: 'Si è verificato un errore. Riprova tra poco.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
    };
  }
}

module.exports = { handleMessage };
