const { callGemini, DISCORD_RESPONSE_FORMAT } = require('./ai/gemini');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser } = require('./ai/tools');
const { executeTool } = require('./tools');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { isAdmin } = require('./config/members');

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx - Normalized message context
 * @returns {{ text: string|null, voiceBuffer: Buffer|null, isVoiceOnly: boolean, attachments: Array }}
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

    // Build system prompt
    const systemPrompt = buildSystemPrompt(ctx);

    // Get available tools
    const tools = getToolsForUser(isActiveMember, userIsAdmin);

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
    ];

    // Add history as individual messages
    // aimlapi.com constraint: only 'user' role supports multimodal array content.
    // Assistant messages must have string content.
    if (ctx.history && ctx.history.length > 0) {
      // Build a text timeline for context
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

          // Collect multimodal data — aimlapi only allows arrays on 'user' role,
          // so assistant media is re-attributed as user context.
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

      // Add text-based history as context
      messages.push({
        role: 'user',
        content: `[CRONOLOGIA ULTIMI MESSAGGI]\n${historyLines.join('\n')}\n[FINE CRONOLOGIA]`,
      });

      // Add user multimodal entries individually so Gemini can see the actual files
      for (const entry of userMultimodalEntries) {
        messages.push(entry);
      }

      // Separator before current message
      messages.push({
        role: 'user',
        content: 'Rispondi al seguente messaggio:',
      });
    }

    // Add current message (can be multimodal — user role supports array content)
    messages.push({ role: 'user', content: ctx.content });

    // User context for tool execution
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

    // Gemini conversation loop (handle tool calls)
    const MAX_TOOL_ROUNDS = 10;
    let rounds = 0;
    const isDiscord = ctx.platform === 'discord';

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      
      // Se il vocale è già stato generato, termina il loop
      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        console.log(`   ⚠️ Vocale già generato, termino il loop`);
        break;
      }
      
      // On final round (no tools pending), use structured output for Discord
      const responseFormat = isDiscord ? DISCORD_RESPONSE_FORMAT : null;
      
      console.log(`🤖 [${ctx.platform.toUpperCase()}] Chiamata Gemini (round ${rounds}/${MAX_TOOL_ROUNDS})`);
      const assistantMsg = await callGemini(messages, tools, responseFormat);

      // Check if there are tool calls
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        console.log(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // Add assistant message with tool calls to conversation
        // Ensure content is never null (AIMLAPI rejects null content)
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          assistantMsg.content = '';
        }
        messages.push(assistantMsg);

        // Execute each tool call
        for (const tc of assistantMsg.tool_calls) {
          try {
            console.log(`   Esecuzione: ${tc.function.name}`);
            const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx);
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

        // Continue the loop for Gemini to process tool results
        continue;
      }

      // No tool calls - this is the final response
      let text = assistantMsg.content || '';
      console.log(`✅ [${ctx.platform.toUpperCase()}] Risposta generata (${text.length} caratteri)`);

      // If voice was generated by a tool, return it directly
      // Still try to parse Discord JSON for title rename
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

      // For Discord: parse structured JSON output
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

    // Check if voice was generated (loop may have broken early)
    if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
      console.log(`   🎤 Vocale pronto (${responseCtx.voiceBuffer.length} bytes)`);
      return {
        text: null,
        voiceBuffer: responseCtx.voiceBuffer,
        isVoiceOnly: true,
        attachments: responseCtx.attachments,
      };
    }

    // Exceeded max rounds
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
