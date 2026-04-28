// src/handler.js
const fs = require('fs');
const path = require('path');
const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser } = require('./ai/tools');
const { executeTool } = require('./tools');
const { isAdmin } = require('./config/members');
const { MAX_TOOL_ROUNDS, MAX_TOOL_ROUNDS_AGENTIC, PLATFORM_DISCORD, MAINTENANCE_MODE, MAINTENANCE_ADMIN_ONLY, MAINTENANCE_USER_MESSAGE, MAINTENANCE_RELEASE_NOTIFY_COMMAND, INTERRUPTED_RUN_TTL_MS } = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { transcribeDocumentsInMessageContent } = require('./utils/media');
const { readMemory } = require('./utils/memoryStore');
const { stripVoiceTags } = require('./utils/text');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { queryRegolamento } = require('./rag/regolamentoRag');
const { getCurrentProject, getLastProject, setCurrentProject, consumeLastCrash, saveLastCrash, acquireLock, releaseLock, startAutoRenewLock } = require('./utils/projectState');
const { listProjects, ensureUserSkeleton, getProjectRoot } = require('./utils/userPaths');
const { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS } = require('./utils/historySync');
const { buildAgenticBriefing } = require('./ai/agenticBriefing');
const { enableReleaseNotify } = require('./tools/releaseNotify');
const { sendWhatsAppDirect } = require('./tools/whatsappSender');

// Tools that unlock the larger agentic round budget. As soon as any of these
// is invoked in a message, the per-message round cap is bumped from
// MAX_TOOL_ROUNDS to MAX_TOOL_ROUNDS_AGENTIC so multi-step pipelines
// (gemix-project create via bash → code_execution → … → send_whatsapp_message) have room.
const AGENTIC_TOOL_NAMES = new Set([
  'code_execution', 'write_file', 'edit_file', 'bash',
]);

const DEFERRED_TOOL_NAMES = new Set(['bash', 'code_execution']);
const PARALLEL_SAFE_TOOL_NAMES = new Set([
  'web_search',
  'browse_page',
  'read_server_rules',
  'read_music_stats',
]);

const log = createLogger('Handler');

/**
 * Walk the project directory and return relative file paths (excludes hidden files and README.md).
 * Capped at maxFiles to avoid bloating the briefing.
 */
function _scanProjectFiles(projectDir, maxFiles = 80) {
  const files = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'README.md') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), relPath);
      } else {
        if (files.length < maxFiles) files.push(relPath);
      }
    }
  }
  walk(projectDir, '');
  return files;
}

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

function orderToolCalls(toolCalls) {
  return [...toolCalls].sort((a, b) =>
    (DEFERRED_TOOL_NAMES.has(a.function.name) ? 1 : 0) - (DEFERRED_TOOL_NAMES.has(b.function.name) ? 1 : 0)
  );
}

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text || '';
  return '';
}

function getReleaseNotifyTarget(ctx, ui) {
  const waJid = ctx.isGroup
    ? ctx.groupId
    : (ctx.waJid || (ui.member ? ui.member.wa : null));
  const chatId = ctx.chatId || ctx.groupId || waJid;
  return { chatId, waJid };
}

function buildMaintenanceReleaseEnabledMessage() {
  return '🔔 Le notifiche degli aggiornamenti di GemiX sono state attivate.\n\nTi avviserò non appena sarà disponibile un nuovo aggiornamento.';
}

function buildMaintenanceReleaseAlreadyEnabledMessage() {
  return 'ℹ️ Le notifiche degli aggiornamenti di GemiX sono già attive.\n\nPotrai disabilitarle chiedendolo direttamente a GemiX quando tornerà disponibile.';
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * Sends every request to Qwen via OpenRouter; audio/video parts are captioned upstream by the media describer (see aiProvider).
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
    // Platform-provided callback: sends an intermediate text message to the
    // user's chat without ending the tool loop. Set by platform handlers
    // (WhatsApp / Discord) so `report_to_user` can deliver status updates.
    sendIntermediate: ctx._sendIntermediate || null,
  };
  let projectLockCtx = null;
  let projectLockOwnerId = null;
  let projectLockHeld = false;
  let stopProjectLockRenew = null;
  let shouldAutoExitProject = false;

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;
    const maintenanceCommand = extractPlainTextContent(ctx.content).trim().toLowerCase();
    const releaseNotifyTarget = getReleaseNotifyTarget(ctx, ui);

    // ── Maintenance gate ──
    // Blocks every non-admin request with a fixed message. Admins always pass.
    if (MAINTENANCE_MODE && MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      if (maintenanceCommand === MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
        const enableResult = enableReleaseNotify(releaseNotifyTarget.chatId, releaseNotifyTarget.waJid);
        const alreadyEnabled = Boolean(enableResult.alreadyEnabled);
        const text = alreadyEnabled
          ? buildMaintenanceReleaseAlreadyEnabledMessage()
          : buildMaintenanceReleaseEnabledMessage();
        if (!alreadyEnabled && ctx.platform === PLATFORM_DISCORD && releaseNotifyTarget.waJid) {
          try {
            await sendWhatsAppDirect(releaseNotifyTarget.waJid, text);
          } catch (err) {
            log.warn(`maintenance release notify mirror to WhatsApp failed: ${err.message}`);
          }
        }
        return {
          text,
          voiceBuffer: null,
          isVoiceOnly: false,
          attachments: [],
          discordTitle: '',
          modelUsed: null,
          systemMessage: true,
        };
      }
      log.info(`   🔒 Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      return {
        text: MAINTENANCE_USER_MESSAGE,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: '',
        modelUsed: null,
        systemMessage: true,
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
        ctx.lastProjectUsed = getLastProject(cloudProbeCtx);
        ctx.projects = listProjects(cloudProbeCtx);
        // Crash recovery: if a previous run was interrupted (bot killed mid
        // tool call), the slot survives on disk. Consume + inject once.
        crashRecovery = consumeLastCrash(cloudProbeCtx, INTERRUPTED_RUN_TTL_MS);
      } catch (err) {
        log.warn(`Failed to load project state: ${err.message}`);
        ctx.currentProject = null;
        ctx.lastProjectUsed = null;
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
      // Per-message agentic gate: starts locked. Set to true after the AI
      // calls `agentic_unlock`, which causes the tool list to be rebuilt
      // (full agentic stack appears, gateway disappears) and a briefing
      // system message to be injected.
      agenticUnlocked: false,
      requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
    };
    projectLockCtx = cloudProbeCtx;
    projectLockOwnerId = userCtx.requestId;

    let tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    let messages = [
      { role: 'system', content: systemPrompt },
    ];

    if (crashRecovery) {
      // Strip filesystem secrets / IDs before injecting into the prompt:
      // absolute server paths, WhatsApp JIDs and Discord IDs must not bleed
      // into the AI context (info-leak hardening).
      const _sanitize = (s) => {
        if (typeof s !== 'string') return s;
        return s
          .replace(/[A-Z]:\\[^\s"']*/gi, '<path>')
          .replace(/\/(?:home|var|opt|root|data|workspace|readonly)[^\s"']*/g, '<path>')
          .replace(/\b\d{8,}@[\w.-]+\b/g, '<wa_jid>')
          .replace(/\b\d{15,}\b/g, '<id>');
      };
      const ageSec = Math.floor((Date.now() - (crashRecovery.ts || 0)) / 1000);
      const lines = [
        '<InterruptedRun>',
        `  The previous tool call for this user did not complete (the bot process was restarted ~${ageSec}s ago).`,
        `  Type: ${crashRecovery.type || 'unknown'}`,
      ];
      if (crashRecovery.project) lines.push(`  Project: ${_sanitize(crashRecovery.project)}`);
      if (crashRecovery.code_preview) {
        lines.push(`  Code preview: ${_sanitize(String(crashRecovery.code_preview).slice(0, 300)).replace(/\n/g, ' ⏎ ')}`);
      }
      if (crashRecovery.command_preview) {
        lines.push(`  Command preview: ${_sanitize(String(crashRecovery.command_preview).slice(0, 300))}`);
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

    // ── Deterministic history prune ─────────────────────────────────────
    // Every file under history/<userId>/ that is no longer reachable from
    // the chat buffer the AI is about to see gets removed (100%, no
    // probabilistic GC). On Discord we additionally enforce a 30-day cap
    // even on still-referenced files (replies can keep old attachments
    // alive forever otherwise).
    try {
      const isDiscord = ctx.platform === PLATFORM_DISCORD;
      const historyUserId = ctx.isGroup ? (ctx.groupId || ctx.userId) : ctx.userId;
      if (historyUserId) {
        const referenced = collectReferencedHistoryFilenames(ctx.history, transcribedUserContent);
        const opts = isDiscord ? { maxAgeMs: DISCORD_MAX_AGE_MS } : {};
        pruneHistory(historyUserId, referenced, opts);
      }
    } catch (e) {
      log.warn(`pruneHistory pre-call failed: ${e.message}`);
    }

    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set(),
      roundCalledTools: new Set(),
    };

    let rounds = 0;
    let lastModelUsed = null;
    let maxRounds = MAX_TOOL_ROUNDS;
    let agenticUnlocked = false;
    let lastAgenticTool = null;
    const runToolCall = async (tc) => {
      if (projectLockCtx && AGENTIC_TOOL_NAMES.has(tc.function.name)) {
        if (!acquireLock(projectLockCtx, projectLockOwnerId)) {
          const lockError = 'Another agentic request is already using this personal cloud. Wait for it to finish before running project or sandbox tools again.';
          log.warn(`   ⛔ Agentic lock denied for ${tc.function.name} (${projectLockOwnerId})`);
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ success: false, error: lockError }),
          };
        }
        if (!projectLockHeld) {
          projectLockHeld = true;
          stopProjectLockRenew = startAutoRenewLock(projectLockCtx, projectLockOwnerId);
        }
      }

      try {
        let argsPreview = '';
        try {
          const parsed = JSON.parse(tc.function.arguments || '{}');
          argsPreview = JSON.stringify(parsed).slice(0, 200);
        } catch {
          argsPreview = String(tc.function.arguments || '').slice(0, 200);
        }
        log.info(`   Executing: ${tc.function.name} args=${argsPreview}`);
        const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx);
        let resultPreview;
        if (Array.isArray(result)) {
          resultPreview = `multimodal[${result.length}] parts=${result.map(p => p.type).join(',')}`;
        } else if (typeof result === 'string') {
          resultPreview = `text(${result.length}) ${result.slice(0, 200).replace(/\s+/g, ' ')}`;
        } else {
          resultPreview = typeof result;
        }
        log.info(`   Result: ${resultPreview}`);
        return {
          role: 'tool',
          tool_call_id: toolCallId,
          content: result,
        };
      } catch (toolErr) {
        log.error(`   ❌ Tool error "${tc.function.name}": ${toolErr.message}`);
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: `Execution error: ${toolErr.message}`,
        };
      }
    };

    while (rounds < maxRounds) {
      rounds++;

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   ⚠️ Voice already generated, skipping round`);
        break;
      }

      log.info(`🤖 [${ctx.platform.toUpperCase()}] AI call (round ${rounds}/${maxRounds}${agenticUnlocked ? ' agentic' : ''})`);
      const _roundsLeft = maxRounds - rounds;
      const _roundHint = _roundsLeft <= 2
        ? `<ToolRound><Current>${rounds}</Current><Max>${maxRounds}</Max><Remaining>${_roundsLeft}</Remaining><Status>critical</Status><Instruction>You are near the tool round limit. Wrap up now, send a final response to the user, and stop using tools.</Instruction></ToolRound>`
        : `<ToolRound><Current>${rounds}</Current><Max>${maxRounds}</Max><Remaining>${_roundsLeft}</Remaining><Status>normal</Status></ToolRound>`;
      messages.push({ role: 'system', content: _roundHint });
      const { message: assistantMsg, provider, model } = await callAI(messages, tools, {
        agenticUnlocked: agenticUnlocked || userCtx.agenticUnlocked,
      });
      messages.pop(); // remove ephemeral round hint — must not persist between rounds
      lastModelUsed = model;
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`🔧 [${ctx.platform.toUpperCase()}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // Bump the per-message round budget on first agentic tool use.
        let unlockTriggered = false;
        for (const tc of assistantMsg.tool_calls) {
          if (tc.function.name === 'agentic_unlock') {
            unlockTriggered = true;
          }
          if (AGENTIC_TOOL_NAMES.has(tc.function.name)) {
            lastAgenticTool = tc.function.name;
            shouldAutoExitProject = shouldAutoExitProject || Boolean(cloudProbeCtx);
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

        // Reset per-round deduplication tracking for idempotent tools
        deliveryCtx.roundCalledTools = new Set();

        // Reorder: file-creation tools first, execution tools last so the AI
        // can write files and run them in the same round.
        const _orderedCalls = orderToolCalls(assistantMsg.tool_calls);
        for (let i = 0; i < _orderedCalls.length; i++) {
          const tc = _orderedCalls[i];
          if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
            log.warn(`   ⚠️ Tool loop interrupted: a tool already produced the final response`);
            break;
          }

          if (PARALLEL_SAFE_TOOL_NAMES.has(tc.function.name)) {
            const parallelCalls = [tc];
            while (i + 1 < _orderedCalls.length && PARALLEL_SAFE_TOOL_NAMES.has(_orderedCalls[i + 1].function.name)) {
              parallelCalls.push(_orderedCalls[i + 1]);
              i++;
            }
            if (parallelCalls.length > 1) {
              log.info(`   ⚡ Executing ${parallelCalls.length} independent read/research tools in parallel`);
            }
            const toolMessages = await Promise.all(parallelCalls.map(runToolCall));
            for (const toolMessage of toolMessages) {
              messages.push(toolMessage);
            }
            continue;
          }

          messages.push(await runToolCall(tc));
        }

        // If agentic_unlock was just executed, swap the tool list and
        // inject the full briefing as a system message for the next round.
        if (unlockTriggered && !userCtx.agenticUnlocked) {
          userCtx.agenticUnlocked = true;
          tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
          if (!agenticUnlocked) {
            agenticUnlocked = true;
            maxRounds = MAX_TOOL_ROUNDS_AGENTIC;
          }
          const _briefingProject = getCurrentProject(userCtx) || ctx.currentProject || null;
          let _projectFiles = [];
          let _readmeContent = null;
          if (_briefingProject) {
            const _pdir = getProjectRoot(userCtx, _briefingProject);
            if (_pdir) {
              _projectFiles = _scanProjectFiles(_pdir);
              try {
                const _rp = path.join(_pdir, 'README.md');
                if (fs.existsSync(_rp)) _readmeContent = fs.readFileSync(_rp, 'utf-8').slice(0, 1500);
              } catch { /* skip */ }
            }
          }
          const briefing = buildAgenticBriefing({
            currentProject: _briefingProject,
            lastProjectUsed: getLastProject(userCtx) || ctx.lastProjectUsed || null,
            projects: ctx.projects || [],
            projectFiles: _projectFiles,
            readmeContent: _readmeContent,
          });
          messages.push({ role: 'system', content: briefing });
          log.info(`   🔓 agentic_unlock invoked → tools rebuilt (${tools.length}) + briefing injected`);
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
      log.info(`✅ [${ctx.platform.toUpperCase()}] Response generated (${text.length} chars)`);

      // Extract Discord thread title from <title> XML tag if present
      if (ctx.platform === PLATFORM_DISCORD) {
        const { text: cleanedText, title } = extractTitleTag(text);
        text = cleanedText;
        if (title) {
          responseCtx.discordTitle = title.replace(/[\u0000-\u001F]/g, '').trim().substring(0, 100);
          log.info(`   📝 Thread title extracted: "${responseCtx.discordTitle}"`);
        }
      }

      if (!text.trim() && !responseCtx.isVoiceOnly && (!responseCtx.attachments || responseCtx.attachments.length === 0)) {
        log.warn('   ⚠️ Empty AI response, sending fallback');
        text = 'Generazione della risposta fallita. Riprova.';
      }

      shouldAutoExitProject = shouldAutoExitProject || Boolean(agenticUnlocked && cloudProbeCtx);

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.info(`   🎤 Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
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
      log.info(`   🎤 Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
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
          project: getCurrentProject(cloudProbeCtx) || getLastProject(cloudProbeCtx) || null,
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
    const platformLabel = (typeof ctx?.platform === 'string' && ctx.platform)
      ? ctx.platform.toUpperCase().padEnd(10)
      : 'UNKNOWN   ';
    log.error(`\n❌ [${platformLabel}] HANDLER ERROR:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    return {
      text: 'Si è verificato un errore. Riprova a breve.',
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: null,
    };
  } finally {
    if (shouldAutoExitProject && projectLockCtx) {
      try { if (getCurrentProject(projectLockCtx)) setCurrentProject(projectLockCtx, null); } catch (e) { log.warn(`auto-exit project failed: ${e.message}`); }
    }
    if (typeof stopProjectLockRenew === 'function') {
      try { stopProjectLockRenew(); } catch (e) { log.warn(`stopProjectLockRenew failed: ${e.message}`); }
    }
    if (projectLockHeld && projectLockCtx && projectLockOwnerId) {
      try { releaseLock(projectLockCtx, projectLockOwnerId); } catch (e) { log.warn(`releaseLock failed: ${e.message}`); }
    }
  }
}

module.exports = { handleMessage };
