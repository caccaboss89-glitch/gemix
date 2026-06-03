// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory (WA) or statute text in prompt (Discord).
//   2. Touch the per-user/group build workspace activity timestamp (WA only).
//   3. Build the messages array: system prompt + chat history + the current
//      user content. Media uses utils/incomingMediaIngress.js →
//      aiFileDelivery.js: tunnel `input_file` URLs, inline <FileContent>, or
//      [Attachment] tags only (Office/archives).
//   4. Loop: call Grok (`/v1/responses`) - tool calls per round in three phases:
//      (1) standard tools parallel, (2) delivery parallel, (3) voice-to-self last - repeat
//      until the model returns plain text (final response) or the round
//      budget is reached.
//   5. Apply the research-team badge (web/X sources) and ship the reply
//      back to the platform.

const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser, getToolAccessError, SET_CONVERSATION_TITLE_TOOL } = require('./ai/tools');
const { executeTool, resetVoiceCount, getVoiceLimitChatKey } = require('./tools');
const { isAdmin } = require('./config/members');
const {
  MAX_TOOL_ROUNDS,
  PLATFORM_DISCORD,
  PLATFORM_WA_PERSONAL,
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY,
  MAINTENANCE_USER_MESSAGE,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,
} = require('./config/constants');
const { createLogger } = require('./utils/logger');

const { resolveWorkspaceId, workspaceIdToSlug } = require('./utils/workspaceId');
const { touchActivity } = require('./utils/buildState');
const { listWorkspaceFiles } = require('./sandbox/buildWorkspace');
const { readMemory } = require('./utils/memoryStore');
const { cleanAssistantResponse } = require('./utils/text');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { loadRegolamento } = require('./utils/regolamento');
const { resolveStorageId, resolvePersonalMemoryFileId } = require('./utils/userPaths');
const { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS } = require('./utils/historySync');
const { enableReleaseNotify } = require('./tools/releaseNotify');
const { sendWhatsAppDirect } = require('./tools/whatsappSender');
const { RELEASE_NOTIFY_ENABLED_PREFIX, RELEASE_NOTIFY_ALREADY_PREFIX, FALLBACK_ERROR_PREFIX } = require('./config/systemMessages');
const { markNotifiedInCall, clearCallNotifications } = require('./utils/notificationDedup');

const log = createLogger('Handler');

// Total wall-clock budget for one main turn. Caps runaway tool loops even
// when the model keeps emitting tool_calls within the round limit.
const SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

const { partitionHandlerToolCalls } = require('./utils/toolCallExecution');

/**
 * Send an intermediate notification message to the active chat (Discord channel
 * or WhatsApp JID), suppressing duplicates within the same AI call.
 *
 * Each (call, kind) pair is allowed at most ONE notification. This keeps the
 * UX calm even when several rounds of the same call would otherwise fire the
 * same banner repeatedly.
 *
 * @param {object} ctx - Handler context (must include `requestId` and platform info)
 * @param {string} kind - 'video_gen' | 'image_gen' | 'research' | etc.
 * @param {string} message - Text to send
 */
async function sendIntermediateNotification(ctx, kind, message) {
  if (!markNotifiedInCall(ctx, kind)) return;
  try {
    if (ctx.platform === PLATFORM_DISCORD && ctx.discordChannel) {
      await ctx.discordChannel.send({ content: message });
      log.info(`   ${kind} notification - Discord: ${message}`);
    } else if (ctx.platform && ctx.platform.startsWith('whatsapp')) {
      // Always the current WhatsApp conversation (personal pair chat, dedicated DM, or group).
      const targetJid = ctx.chatId || ctx.groupId || ctx.waJid;
      if (targetJid) {
        await sendWhatsAppDirect(targetJid, message);
        log.info(`   ${kind} notification - WhatsApp: ${message}`);
      }
    }
  } catch (err) {
    log.warn(`Failed to send ${kind} notification: ${err.message}`);
  }
}

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text || '';
  return '';
}

function reloadLongTermMemory(ctx, ui) {
  if (ctx.platform === PLATFORM_DISCORD) return;
  const isWhatsAppGroup = ctx.isGroup && ctx.platform && ctx.platform.startsWith('whatsapp');
  const isPersonalWa = ctx.platform === PLATFORM_WA_PERSONAL;
  if (isWhatsAppGroup) {
    ctx.groupMemory = readMemory('memory_' + getGroupTaskFileId(ctx.groupId));
    ctx.userMemory = null;
  } else if (isPersonalWa && ctx.chatId) {
    ctx.groupMemory = readMemory(resolvePersonalMemoryFileId(ctx.chatId));
    ctx.userMemory = null;
  } else {
    ctx.userMemory = readMemory('memory_' + ui.taskFileId);
    ctx.groupMemory = null;
  }
}

function getReleaseNotifyTarget(ctx, ui) {
  const waJid = ctx.isGroup
    ? ctx.groupId
    : (ctx.waJid || (ui.member ? ui.member.wa : null));
  const chatId = ctx.chatId || ctx.groupId || waJid;
  return { chatId, waJid };
}

function buildMaintenanceReleaseEnabledMessage() {
  return `${RELEASE_NOTIFY_ENABLED_PREFIX}\n\nTi avviserò non appena sarà disponibile un nuovo aggiornamento.`;
}

function buildMaintenanceReleaseAlreadyEnabledMessage() {
  return `${RELEASE_NOTIFY_ALREADY_PREFIX}\n\nPotrai disabilitarle chiedendolo direttamente a GemiX quando tornerà disponibile.`;
}

const { resolveProfile, toolUnavailableMessage } = require('./config/platformCapabilities');

function _toolNotAvailableMessage(toolName, ctx) {
  return toolUnavailableMessage(toolName, resolveProfile(ctx), {
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember),
    isFirstTurn: Boolean(ctx.isFirstTurn),
  });
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    attachments: [],
    voiceBuffer: null,
    isVoiceOnly: false,
    discordTitle: '',
    // Accumulated research stats from web_x_search calls and any agent
    // sub-runs (e.g. build) - used for the badge appended to the reply.
    researchStats: null,
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;
    const maintenanceCommand = extractPlainTextContent(ctx.content).trim().toLowerCase();
    const releaseNotifyTarget = getReleaseNotifyTarget(ctx, ui);

    // -- Maintenance gate --
    // Blocks every non-admin request with a fixed message. Admins always pass.
    if (MAINTENANCE_MODE && MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      if (maintenanceCommand === MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
        const enableResult = enableReleaseNotify(releaseNotifyTarget.chatId, releaseNotifyTarget.waJid);
        const alreadyEnabled = Boolean(enableResult.alreadyEnabled);
        const text = alreadyEnabled
          ? buildMaintenanceReleaseAlreadyEnabledMessage()
          : buildMaintenanceReleaseEnabledMessage();
        if (ctx.platform === PLATFORM_DISCORD && releaseNotifyTarget.waJid) {
          try {
            await sendWhatsAppDirect(releaseNotifyTarget.waJid, text);
          } catch (err) {
            log.warn(`maintenance release notify mirror to WhatsApp failed: ${err.message}`);
          }
        }
        await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
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
      log.info(`   Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
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

    const isWhatsAppGroup = ctx.isGroup && ctx.platform && ctx.platform.startsWith('whatsapp');
    const isPersonalWa = ctx.platform === PLATFORM_WA_PERSONAL;
    const isDiscord = ctx.platform === PLATFORM_DISCORD;
    const memoryFileId = isDiscord ? null : ('memory_' + ui.taskFileId);
    const sharedMemoryFileId = isPersonalWa && ctx.chatId
      ? resolvePersonalMemoryFileId(ctx.chatId)
      : null;

    let userMemory = null;
    let groupMemory = null;
    if (!isDiscord) {
      if (isWhatsAppGroup) {
        const groupMemoryFileId = 'memory_' + getGroupTaskFileId(ctx.groupId);
        groupMemory = readMemory(groupMemoryFileId);
      } else if (sharedMemoryFileId) {
        groupMemory = readMemory(sharedMemoryFileId);
      } else {
        userMemory = readMemory(memoryFileId);
      }
    }

    ctx.userMemory = userMemory;
    ctx.groupMemory = groupMemory;

    if (isDiscord) {
      ctx.rulesContext = loadRegolamento();
    }

    const userCtx = {
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      memoryFileId: sharedMemoryFileId || memoryFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      userPhone: ctx.userPhone || null,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
      chatId: ctx.chatId || null,
      platform: ctx.platform,
      // First Discord thread turn: expose and force set_conversation_title once
      // (no assistant message in fetched history yet).
      isFirstTurn: ctx.platform === PLATFORM_DISCORD
        && !(Array.isArray(ctx.history) && ctx.history.some(m => m && m.role === 'assistant')),
      requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
      presence: ctx.presence || null,
      // Bound helper for tools that want to fire an intermediate notification
      // (e.g. web_x_search - "Sto consultando il team di ricerca...").
      // Dedup is enforced per (call, kind) inside sendIntermediateNotification.
      sendIntermediateNotification: (kind, message) => sendIntermediateNotification(ctx, kind, message),
    };

    // ctx.requestId is set here so that sendIntermediateNotification (which
    // receives ctx, not userCtx) uses the same call-scoped ID as the dedup
    // keys written by the tools dispatcher (which receives userCtx).
    ctx.requestId = userCtx.requestId;

    const tools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);

    // -- Build workspace activity tracking (WhatsApp only) --
    // Touch last-activity on each main turn and refresh <UserWorkspace> in the prompt.
    const workspaceId = isDiscord ? null : resolveWorkspaceId(ctx);
    if (workspaceId) {
      try { touchActivity(workspaceId); }
      catch (e) { log.warn(`touchActivity failed: ${e.message}`); }
    }
    const refreshUserWorkspace = () => {
      if (isDiscord || !workspaceId) { ctx.userWorkspace = null; return; }
      try {
        const listing = listWorkspaceFiles(workspaceId, 30);
        ctx.userWorkspace = listing.total > 0
          ? {
              total: listing.total,
              files: listing.files,
              more: !!listing.more,
            }
          : null;
      } catch (e) {
        log.warn(`refreshUserWorkspace failed: ${e.message}`);
        ctx.userWorkspace = null;
      }
    };
    refreshUserWorkspace();

    ctx.isFirstTurn = userCtx.isFirstTurn;

    const messages = [
      { role: 'system', content: buildSystemPrompt(ctx) },
    ];
    if (ctx.history && ctx.history.length > 0) {
      messages.push(...ctx.history);
    }
    messages.push({ role: 'user', content: ctx.content });

    // Drop history files no longer referenced in the chat buffer (tags,
    // FileContent paths, _historyPath on media parts). Runs before tunnel
    // registration so tunnel URLs only expose files still on disk.
    try {
      const historyUserId = resolveStorageId(ctx);
      if (historyUserId) {
        if (ctx.historyLoadIncomplete) {
          log.warn('History load incomplete: reference-based prune skipped (age-only disk sweep)');
          pruneHistory(historyUserId, new Set(), {
            maxAgeMs: DISCORD_MAX_AGE_MS,
            ageOnly: true,
          });
        } else {
          const referenced = collectReferencedHistoryFilenames(ctx.history, ctx.content);
          const opts = isDiscord ? { maxAgeMs: DISCORD_MAX_AGE_MS } : {};
          pruneHistory(historyUserId, referenced, opts);
        }
      }
    } catch (pruneErr) {
      log.warn(`pruneHistory failed: ${pruneErr.message}`);
    }

    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set(),
      roundCalledTools: new Set(),
    };

    let rounds = 0;
    let lastModelUsed = null;
    const sessionStartTime = Date.now();
    let sessionDurationLimitReached = false;
    const discordThreadAllowsTitle = Boolean(userCtx.isFirstTurn);

    const runToolCall = async (tc) => {
      try {
        let argsPreview = '';
        try {
          const parsed = JSON.parse(tc.function.arguments || '{}');
          argsPreview = JSON.stringify(parsed).slice(0, 1000);
        } catch {
          argsPreview = String(tc.function.arguments || '').slice(0, 1000);
        }
        log.info(`   Executing: ${tc.function.name} args=${argsPreview}`);
        const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx, tools);
        let resultPreview;
        if (Array.isArray(result)) {
          resultPreview = `multimodal[${result.length}] parts=${result.map(p => p.type).join(',')}`;
        } else if (typeof result === 'string') {
          resultPreview = `text(${result.length}) ${result.slice(0, 1000).replace(/\s+/g, ' ')}`;
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
          content: JSON.stringify({ success: false, error: `Execution error: ${toolErr.message}` }),
        };
      }
    };

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      if (Date.now() - sessionStartTime > SESSION_MAX_DURATION_MS) {
        log.warn('   Session duration limit reached (10 minutes), forcing wrap up');
        sessionDurationLimitReached = true;
        break;
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.warn(`   Voice already generated, skipping round`);
        break;
      }

      const pLabel = (typeof ctx?.platform === 'string' && ctx.platform) ? ctx.platform.toUpperCase() : 'UNKNOWN';
      log.info(`[${pLabel}] AI call (round ${rounds}/${MAX_TOOL_ROUNDS})`);

      // Refresh the workspace listing before each AI call so any file the
      // build sub-agent just produced shows up immediately in <UserWorkspace>.
      refreshUserWorkspace();
      reloadLongTermMemory(ctx, ui);
      userCtx.isFirstTurn = discordThreadAllowsTitle && !responseCtx.discordTitle;
      ctx.isFirstTurn = userCtx.isFirstTurn;
      messages[0].content = buildSystemPrompt(ctx);

      // On the first Discord turn the title-setter tool is forced exactly once
      // via toolChoice so the thread gets named deterministically. It is
      // excluded from the tool list in every other round.
      const callOpts = { maxTurns: MAX_TOOL_ROUNDS, requestId: ctx.requestId };
      let roundTools = tools;
      const forceTitle = rounds === 1 && discordThreadAllowsTitle && !responseCtx.discordTitle;
      if (forceTitle) {
        callOpts.toolChoice = { type: 'function', name: SET_CONVERSATION_TITLE_TOOL };
      } else {
        roundTools = tools.filter(t => t.function?.name !== SET_CONVERSATION_TITLE_TOOL);
      }

      const { message: assistantMsg, provider, model } = await callAI(messages, roundTools, callOpts);
      lastModelUsed = model;
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`[${pLabel}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // OpenAI-compatible reasoning models occasionally return content=null
        // - drop it so the message validates downstream.
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        // Reset per-round deduplication tracking for idempotent tools.
        deliveryCtx.roundCalledTools = new Set();

        const orderedCalls = assistantMsg.tool_calls;
        const allowedToolNames = new Set(roundTools.map(t => t.function?.name).filter(Boolean));
        const phases = partitionHandlerToolCalls(orderedCalls, userCtx);
        const resultsById = new Map();

        const runPhase = async (batch, parallel) => {
          if (parallel) {
            await Promise.all(batch.map(async (tc) => {
              resultsById.set(tc.id, await recordToolResult(tc));
            }));
          } else {
            for (const tc of batch) {
              resultsById.set(tc.id, await recordToolResult(tc));
            }
          }
        };

        const recordToolResult = async (tc) => {
          if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({
                success: false,
                error: 'Turn already completed via voice message; further tools were not run.',
              }),
            };
          }
          const toolBlock = getToolAccessError(tc.function.name, userCtx, {
            allowedRoundNames: allowedToolNames,
            unavailableMessage: (name) => _toolNotAvailableMessage(name, ctx),
          });
          if (toolBlock) {
            log.warn(`   Tool "${tc.function.name}" blocked: ${toolBlock}`);
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ success: false, error: toolBlock }),
            };
          }
          return runToolCall(tc);
        };

        await runPhase(phases.phase1, true);
        await runPhase(phases.phase2, true);
        await runPhase(phases.phase3, false);

        for (const tc of orderedCalls) {
          const msg = resultsById.get(tc.id);
          if (msg) messages.push(msg);
        }

        // Token optimization: tunnel/input_file previews are stripped from tool
        // results after the model evaluates them in the current round.
        const HEAVY_TOOL_PART_TYPES = new Set(['image_url', 'input_file']);
        for (const msg of messages) {
          if (msg.role === 'tool' && Array.isArray(msg.content)) {
            if (msg._heavyMediaPreviewSeen) {
              msg.content = msg.content.filter(p => !HEAVY_TOOL_PART_TYPES.has(p.type));
              if (msg.content.length === 1 && msg.content[0].type === 'text') {
                msg.content = msg.content[0].text;
              }
              delete msg._heavyMediaPreviewSeen;
            } else if (msg.content.some(p => HEAVY_TOOL_PART_TYPES.has(p.type))) {
              msg._heavyMediaPreviewSeen = true;
            }
          }
        }

        continue;
      }

      let text = cleanAssistantResponse(assistantMsg.content || '');
      log.info(`   [${pLabel}] Response generated (${text.length} chars)`);

      if (!text.trim() && !responseCtx.isVoiceOnly && (!responseCtx.attachments || responseCtx.attachments.length === 0)) {
        log.warn('   Empty AI response, sending fallback');
        text = FALLBACK_ERROR_PREFIX;
      }

      // ── Research badge ──────────────────────────────────────────────────
      // Append "🌐: N sources. 𝕏: N posts." when web_x_search is used.
      // Only shown on text replies (not voice-only). Omit a section when its
      // count is zero so the badge stays minimal.
      if (text.trim() && !responseCtx.isVoiceOnly && responseCtx.researchStats) {
        const { webSources, xPosts } = responseCtx.researchStats;
        if (webSources > 0 || xPosts > 0) {
          const parts = [];
          if (webSources > 0) parts.push(`🌐: ${webSources} sources`);
          if (xPosts > 0) parts.push(`𝕏: ${xPosts} posts`);
          text = `${text}\n\n${parts.join('. ')}.`;
          log.info(`   Research badge: ${parts.join(', ')}`);
        }
      }

      if (responseCtx.isVoiceOnly && responseCtx.voiceBuffer) {
        log.info(`   Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
        await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
        return {
          text: null,
          voiceBuffer: responseCtx.voiceBuffer,
          isVoiceOnly: true,
          attachments: responseCtx.attachments,
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
        };
      }

      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
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
      log.info(`   Voice ready (${responseCtx.voiceBuffer.length} bytes)`);
      await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
      return {
        text: null,
        voiceBuffer: responseCtx.voiceBuffer,
        isVoiceOnly: true,
        attachments: responseCtx.attachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
      };
    }

    // ── Forced text wrap-up (session wall clock or tool-round budget) ───
    const wrapUpReason = sessionDurationLimitReached
      ? 'session time limit (10 minutes)'
      : `tool-round budget (${MAX_TOOL_ROUNDS})`;
    log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);
    let wrapUpText = '';
    try {
      reloadLongTermMemory(ctx, ui);
      userCtx.isFirstTurn = discordThreadAllowsTitle && !responseCtx.discordTitle;
      ctx.isFirstTurn = userCtx.isFirstTurn;
      messages[0].content = buildSystemPrompt(ctx);
      const noTitleTools = tools.filter(t => t.function?.name !== SET_CONVERSATION_TITLE_TOOL);
      const wrapUpNote = sessionDurationLimitReached
        ? 'SYSTEM: This turn hit the maximum session duration. You cannot run more tools. Reply now in natural language with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'SYSTEM: You can no longer run tools for this turn. Reply now in natural language: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      messages.push({
        role: 'user',
        content: wrapUpNote,
      });
      const { message: finalMsg, model: finalModel } = await callAI(messages, noTitleTools, {
        toolChoice: 'none',
        requestId: ctx.requestId,
      });
      if (finalModel) lastModelUsed = finalModel;
      wrapUpText = cleanAssistantResponse(finalMsg.content || '');
    } catch (wrapErr) {
      log.error(`   Forced wrap-up call failed: ${wrapErr.message}`);
    }

    if (wrapUpText.trim() && responseCtx.researchStats) {
      const { webSources, xPosts } = responseCtx.researchStats;
      if (webSources > 0 || xPosts > 0) {
        const parts = [];
        if (webSources > 0) parts.push(`🌐: ${webSources} sources`);
        if (xPosts > 0) parts.push(`𝕏: ${xPosts} posts`);
        wrapUpText = `${wrapUpText}\n\n${parts.join('. ')}.`;
      }
    }

    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed: ${vcErr.message}`); }
    return {
      text: wrapUpText.trim() ? wrapUpText : FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: responseCtx.attachments || [],
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
    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed in catch: ${vcErr.message}`); }
    return {
      text: FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: null,
    };
  } finally {
    // Drop per-call notification dedup entries so subsequent AI calls can
    // fire intermediate notifications.
    try { clearCallNotifications(ctx); } catch { /* best effort */ }
  }
}

module.exports = { handleMessage };
