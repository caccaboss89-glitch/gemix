const { callGemini, DISCORD_RESPONSE_FORMAT } = require('./ai/gemini');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser } = require('./ai/tools');
const { executeTool } = require('./tools');
const { isAdmin } = require('./config/members');
const { MAX_TOOL_ROUNDS, PLATFORM_DISCORD } = require('./config/constants');

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
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;

    const systemPrompt = buildSystemPrompt(ctx);

    const tools = getToolsForUser(isActiveMember, userIsAdmin);

    const messages = [
      { role: 'system', content: systemPrompt },
    ];

    if (ctx.history && ctx.history.length > 0) {
      const historyLines = [];
      const userMultimodalEntries = [];

      for (const h of ctx.history) {
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

    const userCtx = {
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
    };

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
      rounds++;
      
      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        console.log(`   ⚠️ Vocale già generato, interruzione ciclo`);
        break;
      }
      
      const responseFormat = isDiscord ? DISCORD_RESPONSE_FORMAT : null;
      
      console.log(`🤖 [${ctx.platform.toUpperCase()}] Chiamata Gemini (round ${rounds}/${MAX_TOOL_ROUNDS})`);
      const assistantMsg = await callGemini(messages, tools, responseFormat);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        console.log(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          assistantMsg.content = '';
        }
        messages.push(assistantMsg);

        for (const tc of assistantMsg.tool_calls) {
          try {
            console.log(`   Esecuzione: ${tc.function.name}`);
            const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx);
            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: result,
            });
          } catch (toolErr) {
            console.error(`   ❌ Errore tool "${tc.function.name}": ${toolErr.message}`);
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
      console.log(`✅ [${ctx.platform.toUpperCase()}] Risposta generata (${text.length} caratteri)`);

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        console.log(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
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

    if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
      console.log(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
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
    console.error(`\n❌ [${ctx.platform.toUpperCase().padEnd(10)}] ERRORE nel handler:`);
    console.error(`   ${err.message}`);
    console.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    return {
      text: 'Si è verificato un errore. Riprova tra poco.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
    };
  }
}

module.exports = { handleMessage };
