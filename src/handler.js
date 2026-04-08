const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser, getToolInstructions } = require('./ai/tools');
const { executeTool } = require('./tools');
const { isAdmin } = require('./config/members');
const { MAX_TOOL_ROUNDS, PLATFORM_DISCORD } = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { hasHistoryImages, hasHistoryDocs, hasHistoryVoices, limitHistoryMediaAttachments } = require('./utils/media');
const { readMemory } = require('./utils/memoryStore');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { queryRegolamento } = require('./rag/regolamentoRag');

const log = createLogger('Handler');

function removeToolInstructionMessages(messages) {
  return messages.filter(m => {
    if (m.role !== 'assistant' || typeof m.content !== 'string') return true;
    return !m.content.startsWith('ISTRUZIONI per lo strumento');
  });
}

function cloneHistoryStructure(history) {
  return history.map(msg => ({
    role: msg.role,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  }));
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * Routes requests to Gemini (audio/Discord) or Qwen (other) via OpenRouter based on message content.
 * @param {object} ctx - Normalized message context { platform, userId, userName, userIdentity, content, history, isGroup, groupId, ... }
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    attachments: [],
    voiceBuffer: null,
    isVoiceOnly: false,
    aboutMeText: null,
    isAboutMeOnly: false,
    historyImagesToInclude: [],
    historyDocsToInclude: [],
    historyVoicesToInclude: [],
    discordTitle: '',
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;

    // Leggi memoria personalizzata (privata o di gruppo)
    const memoryFileId = 'memory_' + ui.taskFileId;
    const isWhatsAppGroup = ctx.isGroup && ctx.platform && ctx.platform.startsWith('whatsapp');

    let userMemory = null;
    let groupMemory = null;
    if (isWhatsAppGroup) {
      const groupMemoryFileId = 'memory_' + getGroupTaskFileId(ctx.groupId);
      groupMemory = readMemory(groupMemoryFileId);
    } else {
      userMemory = readMemory(memoryFileId);
    }

    ctx.userMemory = userMemory;
    ctx.groupMemory = groupMemory;

    log.info('[DEBUG handler] ctx.userIdentity:', ctx.userIdentity);

    // RAG: inietta contesto regolamento per Discord
    if (ctx.platform === PLATFORM_DISCORD) {
      const queryText = typeof ctx.content === 'string'
        ? ctx.content
        : (Array.isArray(ctx.content) ? (ctx.content.find(p => p.type === 'text')?.text || '') : '');
      ctx.ragContext = await queryRegolamento(queryText);
    }

    const systemPrompt = buildSystemPrompt(ctx);

    const historyHasImages = hasHistoryImages(ctx.history);
    const historyHasDocs = hasHistoryDocs(ctx.history);
    const historyHasVoices = hasHistoryVoices(ctx.history);

    const userCtx = {
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      memoryFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      userPhone: ctx.userPhone || null,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
      chatId: ctx.chatId || null,
      platform: ctx.platform,
      hasHistoryImages: historyHasImages,
      hasHistoryDocs: historyHasDocs,
      hasHistoryVoices: historyHasVoices,
      historyFull: ctx.history || [],
    };

    const tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    let messages = [
      { role: 'system', content: systemPrompt },
    ];

    const filteredHistory = ctx.history && ctx.history.length > 0
      ? limitHistoryMediaAttachments(cloneHistoryStructure(ctx.history), 0, 0, 0)
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
    };

    let rounds = 0;
    let lastModelUsed = null;
    const isDiscord = ctx.platform === PLATFORM_DISCORD;

    while (rounds < MAX_TOOL_ROUNDS) {
      messages = removeToolInstructionMessages(messages);
      rounds++;

      if ((responseCtx.historyImagesToInclude && responseCtx.historyImagesToInclude.length > 0) || (responseCtx.historyDocsToInclude && responseCtx.historyDocsToInclude.length > 0) || (responseCtx.historyVoicesToInclude && responseCtx.historyVoicesToInclude.length > 0)) {
        const includeList = [];
        if (responseCtx.historyImagesToInclude && responseCtx.historyImagesToInclude.length > 0) {
          includeList.push({ type: 'text', text: `[Richiesta immagini cronologia]` });
          includeList.push(...responseCtx.historyImagesToInclude);
          responseCtx.historyImagesToInclude = [];
        }
        if (responseCtx.historyDocsToInclude && responseCtx.historyDocsToInclude.length > 0) {
          includeList.push({ type: 'text', text: `[Richiesta documenti cronologia]` });
          includeList.push(...responseCtx.historyDocsToInclude);
          responseCtx.historyDocsToInclude = [];
        }
        if (responseCtx.historyVoicesToInclude && responseCtx.historyVoicesToInclude.length > 0) {
          includeList.push({ type: 'text', text: `[Richiesta vocali cronologia]` });
          includeList.push(...responseCtx.historyVoicesToInclude);
          responseCtx.historyVoicesToInclude = [];
        }
        messages.push({ role: 'user', content: includeList });
      }

      if (responseCtx.isAboutMeOnly && responseCtx.aboutMeText) {
        log.warn(`   ⚠️ Testo 'Chi sono' già preparato, interruzione ciclo`);
        break;
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   ⚠️ Vocale già generato, interruzione ciclo`);
        break;
      }

      log.info(`🤖 [${ctx.platform.toUpperCase()}] Chiamata AI (round ${rounds}/${MAX_TOOL_ROUNDS})`);
      const { message: assistantMsg, provider, model } = await callAI(messages, tools, { isDiscord });
      lastModelUsed = model;
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // Preserve reasoning_details, delete null content for OpenRouter reasoning models
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        for (const tc of assistantMsg.tool_calls) {
          if ((responseCtx.isAboutMeOnly && responseCtx.aboutMeText) ||
            (responseCtx.isVoiceOnly && responseCtx.voiceBuffer)) {
            log.warn(`   ⚠️ Ciclo tool interrotto: un tool ha già generato la risposta finale`);
            break;
          }

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

      if (!text.trim() && !responseCtx.isAboutMeOnly && !responseCtx.isVoiceOnly && (!responseCtx.attachments || responseCtx.attachments.length === 0)) {
        log.warn('   ⚠️ Risposta AI vuota, invio fallback');
        text = 'Mi dispiace, non sono riuscito a generare una risposta valida. Riprova tra poco.';
      }

      if (responseCtx.isAboutMeOnly && responseCtx.aboutMeText) {
        log.info(`   📖 Testo 'Chi sono' pronto (${responseCtx.aboutMeText.length} caratteri)`);
        return {
          text: responseCtx.aboutMeText,
          voiceBuffer: null,
          isVoiceOnly: false,
          isAboutMeOnly: true,
          attachments: responseCtx.attachments,
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
        };
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.info(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
        return {
          text: null,
          voiceBuffer: responseCtx.voiceBuffer,
          isVoiceOnly: true,
          attachments: responseCtx.attachments,
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
        };
      }

      return {
        text: text || null,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: responseCtx.attachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
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
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
      };
    }

    if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
      log.info(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
      return {
        text: null,
        voiceBuffer: responseCtx.voiceBuffer,
        isVoiceOnly: true,
        attachments: responseCtx.attachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
      };
    }

    return {
      text: 'Mi dispiace, ho incontrato un problema elaborando la tua richiesta. Riprova.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed,
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
      modelUsed: null,
    };
  }
}

module.exports = { handleMessage };
