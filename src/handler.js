// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory (WA) or statute text in prompt (Discord).
//   2. Touch the per-user/group build workspace activity timestamp (WA only).
//   3. Build the messages array: system prompt + chat history + the current
//      user content. Media uses utils/incomingMediaIngress.js →
//      aiFileDelivery.js: native `input_image` / `input_file` parts via
//      public URLs, or [Attachment] tags only (raw binaries).
//   4. Loop: call Grok (`/v1/responses`) - tool calls per round in three phases:
//      (1) standard tools parallel, (2) delivery parallel, (3) voice-to-self last - repeat
//      until the model returns the final response or the round budget is
//      reached. While deliverable files exist (and on the first Discord
//      thread turn) the final reply is structured JSON (response /
//      attachments / conversation_title) enforced via response_format.
//   5. Apply the research badge (real web/X search counts) and ship the
//      reply back to the platform.

const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser, getToolAccessError } = require('./ai/tools');
const { buildGemixResponseFormat, parseStructuredReply } = require('./ai/responseSchema');
const { resolveDeliverySelection } = require('./utils/deliverySelection');
const { collectGemixVoiceTranscriptParts } = require('./utils/voiceTranscripts');
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
const { cleanAssistantResponse, stripOutgoingDeliveryArtifacts } = require('./utils/text');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { loadRegolamento } = require('./utils/regolamento');
const { resolveStorageId, resolvePersonalMemoryFileId } = require('./utils/userPaths');
const { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS } = require('./utils/historySync');
const { enableReleaseNotify } = require('./tools/releaseNotify');
const { sendWhatsAppDirect } = require('./tools/whatsappSender');
const {
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
  PER_ROUND_TOOL_LIMITS,
} = require('./utils/toolCallExecution');
const { sendIntermediateNotification } = require('./utils/intermediateNotification');
const { RELEASE_NOTIFY_ENABLED_PREFIX, RELEASE_NOTIFY_ALREADY_PREFIX, FALLBACK_ERROR_PREFIX } = require('./config/systemMessages');
const { markNotifiedInCall, clearCallNotifications } = require('./utils/notificationDedup');

const log = createLogger('Handler');

// Total wall-clock budget for one main turn. Caps runaway tool loops even
// when the model keeps emitting tool_calls within the round limit.
const SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

const { partitionHandlerToolCalls } = require('./utils/toolCallExecution');

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
    // Accumulated stats from native server-side web/X searches (main brain
    // and build sub-agent) - used for the badge appended to the reply.
    researchStats: null,
    // True once a server-side search ran this turn: the model may hold
    // public URLs it wants to deliver, so the structured reply activates.
    searchUsed: false,
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = ui.member ? isAdmin(ui.member) : false;
    let maintenanceCommand = extractPlainTextContent(ctx.content).trim().toLowerCase();
    
    // Extract command from formatted message: [DATE, TIME] UserName: /command ...
    // Find the LAST colon (after the username) and extract the first token after it
    const lastColonIdx = maintenanceCommand.lastIndexOf(':');
    if (lastColonIdx !== -1) {
      const afterColon = maintenanceCommand.substring(lastColonIdx + 1).trim();
      const firstToken = afterColon.split(/\s+/)[0];
      if (firstToken) {
        maintenanceCommand = firstToken;
      }
    }
    
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
      // First Discord thread turn: the structured reply carries the required
      // conversation_title (no assistant message in fetched history yet).
      isFirstTurn: ctx.platform === PLATFORM_DISCORD
        && !(Array.isArray(ctx.history) && ctx.history.some(m => m && m.role === 'assistant')),
      requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
      presence: ctx.presence || null,
      // Bound helper for tools that want to fire an intermediate notification
      // (e.g. build - "Sto delegando il lavoro al coder agent...").
      // Dedup is enforced per (call, kind) inside sendIntermediateNotification.
      sendIntermediateNotification: (kind, message) => sendIntermediateNotification(ctx, kind, message),
    };

    // ctx.requestId is set here so that sendIntermediateNotification (which
    // receives ctx, not userCtx) uses the same call-scoped ID as the dedup
    // keys written by the tools dispatcher (which receives userCtx).
    ctx.requestId = userCtx.requestId;

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

    // GemiX voice messages in history are tags only (assistant entries carry
    // no file parts): attach their transcript .txt files to the current turn
    // so the model always sees what was said.
    let currentContent = ctx.content;
    try {
      const transcriptParts = await collectGemixVoiceTranscriptParts(ctx.history, resolveStorageId(ctx));
      if (transcriptParts.length > 0) {
        const baseParts = typeof currentContent === 'string'
          ? [{ type: 'text', text: currentContent }]
          : [...(Array.isArray(currentContent) ? currentContent : [])];
        currentContent = [...baseParts, ...transcriptParts];
        log.info(`   Attached ${transcriptParts.length} voice transcript file(s) to the current turn`);
      }
    } catch (txErr) {
      log.warn(`voice transcript attach failed: ${txErr.message}`);
    }
    messages.push({ role: 'user', content: currentContent });

    // Drop history files no longer referenced in the chat buffer (tags,
    // _historyPath on media parts). Runs first so public-URL uploads only
    // expose files still on disk.
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
      roundToolCounts: new Map(),
    };

    let rounds = 0;
    let lastModelUsed = null;
    const sessionStartTime = Date.now();
    let sessionDurationLimitReached = false;
    const discordFirstTurn = Boolean(userCtx.isFirstTurn);

    // Structured-reply state, recomputed before every AI call:
    //   - deliverable files exist -> optional `attachments` field,
    //   - first Discord thread turn -> required `conversation_title`.
    // When neither applies the reply stays plain text (no response_format).
    const computeDeliveryState = () => {
      const bufferFiles = (responseCtx.attachments || []).map(a => a.name).filter(Boolean);
      return {
        active: bufferFiles.length > 0 || responseCtx.searchUsed,
        bufferFiles,
        includeTitle: discordFirstTurn && !responseCtx.discordTitle,
      };
    };

    const accumulateSearchStats = (searchStats) => {
      if (!searchStats || (searchStats.webSources === 0 && searchStats.xPosts === 0)) return;
      if (!responseCtx.researchStats) {
        responseCtx.researchStats = { webSources: 0, xPosts: 0 };
      }
      responseCtx.researchStats.webSources += searchStats.webSources;
      responseCtx.researchStats.xPosts += searchStats.xPosts;
      responseCtx.searchUsed = true;
    };

    // Resolve the attachments the model listed in its structured final reply
    // (delivery-buffer filenames and/or public URLs). Only listed files ship.
    const resolveFinalAttachments = async (parsed) => {
      if (!parsed.structured) return [];
      const { attachments, missing } = await resolveDeliverySelection(parsed.attachments, responseCtx);
      if (missing.length > 0) {
        log.warn(`   Final reply attachments not resolved: ${missing.join(', ')}`);
      }
      return attachments;
    };

    const applyParsedTitle = (parsed) => {
      if (!parsed.title) return;
      const title = stripOutgoingDeliveryArtifacts(
        parsed.title.replace(/[\u0000-\u001F]/g, ''),
      ).trim().substring(0, 100);
      if (title) responseCtx.discordTitle = title;
    };

    // Tool defs of the round in flight (rebuilt per round: the delivery
    // attachments parameter appears only while deliverable files exist).
    let currentRoundTools = [];

    const runToolCall = async (tc) => {
      try {
        log.info(`   Executing: ${tc.function.name} args=${tc.function.arguments || '{}'}`);
        const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx, currentRoundTools);
        const resultLog = Array.isArray(result) || typeof result === 'object'
          ? JSON.stringify(result)
          : String(result ?? '');
        log.info(`   Result: ${resultLog}`);
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

      // Delivery / structured-reply state for this round: the prompt, the
      // delivery tool parameters, and the response_format all follow it.
      const deliveryState = computeDeliveryState();
      ctx.deliveryState = deliveryState;
      ctx.isFirstTurn = deliveryState.includeTitle;
      userCtx.isFirstTurn = deliveryState.includeTitle;
      userCtx.hasDeliverableFiles = deliveryState.active;
      messages[0].content = buildSystemPrompt(ctx);

      const roundTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      currentRoundTools = roundTools;
      const responseFormat = buildGemixResponseFormat({
        includeTitle: deliveryState.includeTitle,
        includeAttachments: deliveryState.active,
      });
      const callOpts = { maxTurns: MAX_TOOL_ROUNDS, requestId: ctx.requestId, responseFormat };

      const { message: assistantMsg, provider, model, searchStats } = await callAI(messages, roundTools, callOpts);
      lastModelUsed = model;
      accumulateSearchStats(searchStats);
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`[${pLabel}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // OpenAI-compatible reasoning models occasionally return content=null
        // - drop it so the message validates downstream.
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        // Reset per-round tool caps (generate_image x5, generate_video x3, etc.).
        deliveryCtx.roundToolCounts = new Map();

        const orderedCalls = assistantMsg.tool_calls;
        const allowedToolNames = new Set(roundTools.map(t => t.function?.name).filter(Boolean));
        const phases = partitionHandlerToolCalls(orderedCalls, userCtx);
        const resultsById = new Map();

        const runPhase = async (batch, parallel) => {
          const blockedOncePerRound = perRoundCappedDuplicateIds(batch, PER_ROUND_TOOL_LIMITS);
          if (parallel) {
            await Promise.all(batch.map(async (tc) => {
              resultsById.set(tc.id, await recordToolResult(tc, blockedOncePerRound));
            }));
          } else {
            for (const tc of batch) {
              resultsById.set(tc.id, await recordToolResult(tc, blockedOncePerRound));
            }
          }
        };

        const recordToolResult = async (tc, blockedOncePerRound = new Set()) => {
          if (blockedOncePerRound.has(tc.id)) {
            const name = tc.function?.name || 'tool';
            const cap = PER_ROUND_TOOL_LIMITS[name];
            log.warn(`   Tool "${name}" blocked: per-round cap (${cap}) exceeded in same model turn`);
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: perRoundCapErrorPayload(name, cap),
            };
          }
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

        // Token optimization: native file/image previews are stripped from tool
        // results after the model evaluates them in the current round.
        const HEAVY_TOOL_PART_TYPES = new Set(['image_url', 'input_file', 'input_image']);
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

      // Structured replies (response_format active) carry the user-facing
      // text in `response`, plus optional attachments and the Discord title.
      let finalAttachments = [];
      let text;
      if (responseFormat) {
        const parsed = parseStructuredReply(assistantMsg.content || '');
        if (!parsed.structured) {
          log.warn('   Structured reply expected but content was not valid JSON; using raw text');
        }
        applyParsedTitle(parsed);
        finalAttachments = await resolveFinalAttachments(parsed);
        text = cleanAssistantResponse(parsed.text || '');
      } else {
        text = cleanAssistantResponse(assistantMsg.content || '');
      }
      log.info(`   [${pLabel}] Response generated (${text.length} chars, ${finalAttachments.length} attachment(s))`);

      if (!text.trim() && !responseCtx.isVoiceOnly && finalAttachments.length === 0) {
        log.warn('   Empty AI response, sending fallback');
        text = FALLBACK_ERROR_PREFIX;
      }

      // ── Research badge ──────────────────────────────────────────────────
      // Append "🌐: N sources. 𝕏: N posts." when server-side web/X search
      // ran (real counts from the API payloads). Only shown on text replies
      // (not voice-only). Omit a section when its count is zero so the badge
      // stays minimal.
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
        attachments: finalAttachments,
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
    let wrapUpAttachments = [];
    try {
      reloadLongTermMemory(ctx, ui);
      const deliveryState = computeDeliveryState();
      ctx.deliveryState = deliveryState;
      ctx.isFirstTurn = deliveryState.includeTitle;
      userCtx.isFirstTurn = deliveryState.includeTitle;
      userCtx.hasDeliverableFiles = deliveryState.active;
      messages[0].content = buildSystemPrompt(ctx);
      const wrapUpTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      const responseFormat = buildGemixResponseFormat({
        includeTitle: deliveryState.includeTitle,
        includeAttachments: deliveryState.active,
      });
      const wrapUpNote = sessionDurationLimitReached
        ? 'SYSTEM: This turn hit the maximum session duration. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'SYSTEM: You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      messages.push({
        role: 'user',
        content: wrapUpNote,
      });
      const { message: finalMsg, model: finalModel, searchStats } = await callAI(messages, wrapUpTools, {
        toolChoice: 'none',
        requestId: ctx.requestId,
        responseFormat,
      });
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(searchStats);
      if (responseFormat) {
        const parsed = parseStructuredReply(finalMsg.content || '');
        applyParsedTitle(parsed);
        wrapUpAttachments = await resolveFinalAttachments(parsed);
        wrapUpText = cleanAssistantResponse(parsed.text || '');
      } else {
        wrapUpText = cleanAssistantResponse(finalMsg.content || '');
      }
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
      attachments: wrapUpAttachments,
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
