// src/handler.js
const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser } = require('./ai/tools');
const { executeTool } = require('./tools');
const { isAdmin } = require('./config/members');
const {
  MAX_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS_AGENTIC,
  PLATFORM_DISCORD,
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY,
  MAINTENANCE_USER_MESSAGE,
  INTERRUPTED_RUN_TTL_MS,
} = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { transcribeDocumentsInMessageContent } = require('./utils/media');
const { readMemory } = require('./utils/memoryStore');
const { stripVoiceTags } = require('./utils/text');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { queryRegolamento } = require('./rag/regolamentoRag');
const { getCurrentProject, consumeLastCrash, saveLastCrash } = require('./utils/projectState');
const { listProjects, ensureUserSkeleton } = require('./utils/userPaths');

// Tools that unlock the larger agentic round budget. As soon as any of these
// is invoked in a message, the per-message round cap is bumped from
// MAX_TOOL_ROUNDS to MAX_TOOL_ROUNDS_AGENTIC so multi-step pipelines
// (create_project → code_execution → … → send_whatsapp_message) have room.
const AGENTIC_TOOL_NAMES = new Set([
  'code_execution', 'write_file', 'edit_file', 'bash',
  'create_project', 'switch_project', 'delete_project', 'cleanup_project',
  'copy_to_permanent', 'copy_to_project',
]);

const log = createLogger('Handler');

/**
 * Extract and remove <title>...</title> XML tag from text.
 * Used to extract Discord thread title from AI response.
 * @param {string} text - Text that may contain <title> tag
 * @returns {object} { text: string without title tag, title: extracted title or empty string }
 */
function extractTitleTag(text) {
  if (!text) return { text, title: '' };
  const titleMatch = text.match(/<title>(.*?)<\/title>/i);
  if (!titleMatch) return { text, title: '' };

  const title = titleMatch[1].trim();
  const cleanText = text.replace(/<title>.*?<\/title>/i, '').trim();
  return { text: cleanText, title };
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
    discordTitle: '',
    imageSearchNextId: 1,
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;

    // ── Maintenance gate ──
    // Blocks every non-admin request with a fixed message. Admins always pass.
    if (MAINTENANCE_MODE && MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      log.info(`   🔒 Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      return {
        text: MAINTENANCE_USER_MESSAGE,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: '',
        modelUsed: null,
      };
    }

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

    // Personal cloud: inject current project + project list (WhatsApp only)
    let crashRecovery = null;
    let cloudProbeCtx = null;
    if (ctx.platform && !ctx.platform.startsWith('discord')) {
      try {
        cloudProbeCtx = {
          platform: ctx.platform,
          userId: ctx.userId,
          waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
          isGroup: ctx.isGroup,
          groupId: ctx.groupId,
        };
        ensureUserSkeleton(cloudProbeCtx);
        ctx.currentProject = getCurrentProject(cloudProbeCtx);
        ctx.projects = listProjects(cloudProbeCtx);
        // Crash recovery: if a previous run was interrupted (bot killed mid
        // tool call), the slot survives on disk. Consume + inject once.
        crashRecovery = consumeLastCrash(cloudProbeCtx, INTERRUPTED_RUN_TTL_MS);
      } catch (err) {
        log.warn(`Failed to load project state: ${err.message}`);
        ctx.currentProject = null;
        ctx.projects = [];
      }
    }

    // RAG: inietta contesto regolamento per Discord
    if (ctx.platform === PLATFORM_DISCORD) {
      const queryText = typeof ctx.content === 'string'
        ? ctx.content
        : (Array.isArray(ctx.content) ? (ctx.content.find(p => p.type === 'text')?.text || '') : '');
      ctx.ragContext = await queryRegolamento(queryText);
    }

    const systemPrompt = buildSystemPrompt(ctx);



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
    };

    const tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    let messages = [
      { role: 'system', content: systemPrompt },
    ];

    if (crashRecovery) {
      const ageSec = Math.floor((Date.now() - (crashRecovery.ts || 0)) / 1000);
      const lines = [
        '<InterruptedRun>',
        `  The previous tool call for this user did not complete (the bot process was restarted ~${ageSec}s ago).`,
        `  Type: ${crashRecovery.type || 'unknown'}`,
      ];
      if (crashRecovery.project) lines.push(`  Project: ${crashRecovery.project}`);
      if (crashRecovery.code_preview) {
        lines.push(`  Code preview: ${String(crashRecovery.code_preview).slice(0, 300).replace(/\n/g, ' ⏎ ')}`);
      }
      lines.push('  Before doing anything else, briefly check the project state (read_file / list new files in output/) and then resume the user request.');
      lines.push('</InterruptedRun>');
      messages.push({ role: 'system', content: lines.join('\n') });
      log.info(`   ♻️ Injected interrupted-run notice (type=${crashRecovery.type})`);
    }

    if (ctx.history && ctx.history.length > 0) {
      const historyLines = ctx.history.map(h =>
        typeof h.content === 'string'
          ? h.content
          : (Array.isArray(h.content)
            ? (h.content.find(p => p.type === 'text')?.text || '[media]')
            : String(h.content))
      );

      messages.push({
        role: 'user',
        content: `[RECENT MESSAGE HISTORY]\n${historyLines.join('\n')}\n[END HISTORY]`,
      });

      messages.push({
        role: 'user',
        content: 'Reply to the following message:',
      });
    }

    // Transcribe documents in ctx.content before adding
    const transcribedUserContent = await transcribeDocumentsInMessageContent(ctx.content);
    messages.push({ role: 'user', content: transcribedUserContent });


    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set(),
    };

    let rounds = 0;
    let lastModelUsed = null;
    let maxRounds = MAX_TOOL_ROUNDS;
    let agenticUnlocked = false;
    let lastAgenticTool = null;

    while (rounds < maxRounds) {
      rounds++;

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   ⚠️ Vocale già generato, salto ciclo`);
        break;
      }

      log.info(`🤖 [${ctx.platform.toUpperCase()}] Chiamata AI (round ${rounds}/${maxRounds}${agenticUnlocked ? ' agentic' : ''})`);
      const { message: assistantMsg, provider, model } = await callAI(messages, tools);
      lastModelUsed = model;
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // Bump the per-message round budget on first agentic tool use.
        for (const tc of assistantMsg.tool_calls) {
          if (AGENTIC_TOOL_NAMES.has(tc.function.name)) {
            lastAgenticTool = tc.function.name;
            if (!agenticUnlocked) {
              agenticUnlocked = true;
              maxRounds = MAX_TOOL_ROUNDS_AGENTIC;
              log.info(`   🧠 Agentic tool detected → round budget bumped to ${maxRounds}`);
            }
          }
        }
        // Preserve reasoning_details, delete null content for OpenRouter reasoning models
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        for (const tc of assistantMsg.tool_calls) {
          if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
            log.warn(`   ⚠️ Ciclo tool interrotto: un tool ha già generato la risposta finale`);
            break;
          }

          try {
            let argsPreview = '';
            try {
              const parsed = JSON.parse(tc.function.arguments || '{}');
              argsPreview = JSON.stringify(parsed).slice(0, 200);
            } catch { argsPreview = String(tc.function.arguments || '').slice(0, 200); }
            log.info(`   Esecuzione: ${tc.function.name} args=${argsPreview}`);
            const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx);
            let resultPreview;
            if (Array.isArray(result)) {
              resultPreview = `multimodal[${result.length}] parts=${result.map(p => p.type).join(',')}`;
            } else if (typeof result === 'string') {
              resultPreview = `text(${result.length}) ${result.slice(0, 200).replace(/\s+/g, ' ')}`;
            } else {
              resultPreview = typeof result;
            }
            log.info(`   Risultato: ${resultPreview}`);
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
              content: `Execution error: ${toolErr.message}`,
            });
          }
        }

        // Token optimization: strip image previews from tool results the AI has already seen.
        // The AI evaluated them in this round; keeping base64 data wastes context in future rounds.
        for (const msg of messages) {
          if (msg.role === 'tool' && Array.isArray(msg.content) && msg._imagePreviewSeen) {
            msg.content = msg.content.filter(p => p.type !== 'image_url');
            if (msg.content.length === 1 && msg.content[0].type === 'text') {
              msg.content = msg.content[0].text;
            }
            delete msg._imagePreviewSeen;
          }
          // Mark current multimodal tool results so they get stripped NEXT round (after AI sees them)
          if (msg.role === 'tool' && Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url')) {
            msg._imagePreviewSeen = true;
          }
        }

        continue;
      }

      let text = stripVoiceTags(assistantMsg.content || '');
      log.info(`✅ [${ctx.platform.toUpperCase()}] Risposta generata (${text.length} caratteri)`);

      // Extract Discord thread title from <title> XML tag if present
      if (ctx.platform === PLATFORM_DISCORD) {
        const { text: cleanedText, title } = extractTitleTag(text);
        text = cleanedText;
        if (title) {
          responseCtx.discordTitle = title.replace(/[\u0000-\u001F]/g, '').trim().substring(0, 100);
          log.info(`   📝 Titolo thread estratto: "${responseCtx.discordTitle}"`);
        }
      }

      if (!text.trim() && !responseCtx.isVoiceOnly && (!responseCtx.attachments || responseCtx.attachments.length === 0)) {
        log.warn('   ⚠️ Risposta AI vuota, invio fallback');
        text = 'Generazione della risposta fallita. Riprova.';
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

    // Loop exhausted without a final answer: persist a crash slot so the
    // next user message can ask the AI to resume gracefully (only useful
    // when an agentic pipeline was in flight).
    if (cloudProbeCtx && agenticUnlocked) {
      try {
        saveLastCrash(cloudProbeCtx, {
          type: 'tool_rounds_exhausted',
          project: ctx.currentProject || null,
          last_tool: lastAgenticTool,
          rounds_used: rounds,
        });
      } catch (e) { log.warn(`saveLastCrash failed: ${e.message}`); }
    }

    return {
      text: 'Generazione della risposta fallita. Riprova.',
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
      text: 'Si è verificato un errore. Riprova a breve.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      modelUsed: null,
    };
  }
}

module.exports = { handleMessage };
