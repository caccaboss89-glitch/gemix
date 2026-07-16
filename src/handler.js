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
//      public URLs (user/history files attached natively; assistant-side
//      entries including GemiX voice stay [Attachment] tags only), or tag-only
//      for raw binaries. GemiX past voice transcripts are injected as
//      <PastVoiceReply> blocks on the current turn (WA dedicated only).
//   4. Loop: call Grok (`/v1/responses`) - tool calls per round in two phases:
//      (1) standard tools parallel, (2) delivery parallel - repeat until the
//      model returns the final response or the round budget is reached. The
//      final reply is always structured JSON (response / optional attachments,
//      plus conversation_title on the first Discord thread turn, plus a `voice`
//      flag on WA dedicated) enforced via a fixed text.format schema. When
//      `voice:true` (WA dedicated only), `response` is spoken via TTS instead of text.
//   5. Apply the research badge (real web/X search counts) and ship the
//      reply back to the platform.

const { callAI } = require('./ai/aiProvider');
const { buildSystemPrompt } = require('./ai/systemPrompt');
const { getToolsForUser, getToolAccessError } = require('./ai/tools');
const { buildGemixResponseFormat, parseStructuredReply } = require('./ai/responseSchema');
const { resolveDeliverySelection } = require('./utils/deliverySelection');
const { buildPastVoiceReplyBlocks } = require('./utils/voiceTranscripts');
const { generateVoice } = require('./tools/voiceMessage');
const { sanitizeVoiceMessageText } = require('./utils/text');
const { getCapabilities } = require('./config/platformCapabilities');
const { executeTool, resetVoiceCount, getVoiceLimitChatKey } = require('./tools');
const { getVoiceCount, incrementVoiceCount } = require('./utils/voiceCounter');
const {
  MAX_TOOL_ROUNDS,
  MAX_TTS_CHARS,
  PLATFORM_DISCORD,
  PLATFORM_WA_DEDICATED,
  PLATFORM_WA_PERSONAL,
  MAINTENANCE_MODE,
  MAINTENANCE_ADMIN_ONLY,
  MAINTENANCE_USER_MESSAGE,
  MAINTENANCE_RELEASE_NOTIFY_COMMAND,
} = require('./config/constants');
const { createLogger } = require('./utils/logger');
const { appendResearchBadge, buildResearchBadgeText } = require('./utils/footer');

const { resolveWorkspaceId, workspaceIdToSlug } = require('./utils/workspaceId');
const { touchActivity } = require('./utils/buildState');
const { listWorkspaceFiles } = require('./sandbox/buildWorkspace');
const { readMemory } = require('./utils/memoryStore');
const { cleanAssistantResponse, stripOutgoingDeliveryArtifacts } = require('./utils/text');
const { sanitizeDiscordThreadTitle } = require('./utils/discord');
const { getGroupTaskFileId } = require('./utils/userIdentifier');
const { loadRegolamento } = require('./utils/regolamento');
const { resolveStorageId, resolvePersonalMemoryFileId } = require('./utils/userPaths');
const { generatePromptCacheKey } = require('./utils/promptCacheKey');
const { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS } = require('./utils/historySync');
const { enableReleaseNotify } = require('./tools/releaseNotify');
const { sendWhatsAppDirect } = require('./tools/whatsappSender');
const {
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
  PER_ROUND_TOOL_LIMITS,
} = require('./utils/toolCallExecution');
const { sendIntermediateNotification } = require('./utils/intermediateNotification');
const {
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX,
  GROK_CREDIT_EXHAUSTED_MESSAGE,
} = require('./config/systemMessages');
const { isGrokCreditExhaustedError } = require('./ai/apiClient');
const { clearCallNotifications } = require('./utils/notificationDedup');

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
  });
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle?, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId?, systemMessage? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    attachments: [],
    discordTitle: '',
    // Accumulated stats from native server-side web/X searches (main brain
    // and build sub-agent) - used for the badge appended to the reply.
    researchStats: null,
  };

  let pruneAfterTurn = null;
  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = Boolean(ui.isAdmin);
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
    // Voice replies are a structured-reply flag (WhatsApp dedicated only),
    // never a tool. The model sets `voice:true` and writes `response` with TTS tags.
    const allowVoice = Boolean(getCapabilities(ctx).voiceReply);
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
    // Touch last-activity on each main turn and refresh <BuildWorkspace> in the prompt.
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

    // GemiX voice messages in history are [Attachment] tags only (assistant
    // entries cannot carry file parts): inject <PastVoiceReply> on this turn.
    let currentContent = ctx.content;
    if (allowVoice) {
      try {
        const pastVoiceBlocks = buildPastVoiceReplyBlocks(ctx.history, resolveStorageId(ctx));
        if (pastVoiceBlocks.length > 0) {
          const baseParts = typeof currentContent === 'string'
            ? [{ type: 'text', text: currentContent }]
            : [...(Array.isArray(currentContent) ? currentContent : [])];
          currentContent = [...baseParts, ...pastVoiceBlocks];
          const blockCount = (pastVoiceBlocks[0].text.match(/<PastVoiceReply/g) || []).length;
          log.info(`   Injected ${blockCount} <PastVoiceReply> block(s) on the current turn`);
        }
      } catch (txErr) {
        log.warn(`PastVoiceReply inject failed: ${txErr.message}`);
      }
    }
    messages.push({ role: 'user', content: currentContent });

    try {
      const historyUserId = resolveStorageId(ctx);
      if (historyUserId) {
        if (ctx.historyLoadIncomplete) {
          pruneAfterTurn = {
            historyUserId,
            referenced: new Set(),
            opts: { maxAgeMs: DISCORD_MAX_AGE_MS, ageOnly: true },
          };
        } else {
          const referenced = collectReferencedHistoryFilenames(ctx.history, ctx.content);
          const opts = isDiscord ? { maxAgeMs: DISCORD_MAX_AGE_MS } : {};
          pruneAfterTurn = { historyUserId, referenced, opts };
        }
      }
    } catch (pruneErr) {
      log.warn(`pruneHistory setup failed: ${pruneErr.message}`);
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
    const promptCacheKey = generatePromptCacheKey(userCtx);
    const discordFirstTurn = Boolean(userCtx.isFirstTurn);

    // Structured-reply state, recomputed before every AI call: `bufferFiles`
    // lists what is currently in the delivery buffer (surfaced in the prompt),
    // and `includeTitle` flags the first Discord thread turn (which adds the
    // required `conversation_title`). The JSON schema itself is fixed every round.
    const computeDeliveryState = () => {
      const bufferFiles = (responseCtx.attachments || []).map(a => a.name).filter(Boolean);
      return {
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
    };

    // Resolve the attachments the model listed in its structured final reply
    // (delivery-buffer filenames and/or public URLs). Only listed files ship.
    const resolveFinalAttachments = async (parsed) => {
      if (!parsed.structured) return [];
      const { attachments, missing } = await resolveDeliverySelection(parsed.attachments, responseCtx, userCtx);
      if (missing.length > 0) {
        log.warn(`   Final reply attachments not resolved: ${missing.join(', ')}`);
      }
      return attachments;
    };

    const applyParsedTitle = (parsed) => {
      if (!parsed.title) return;
      const title = sanitizeDiscordThreadTitle(stripOutgoingDeliveryArtifacts(parsed.title));
      if (title) responseCtx.discordTitle = title;
    };

    // Tool defs for the round in flight (platform/membership-gated; delivery
    // buffer state is injected into the system prompt, not into tool schemas).
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

    // Generate a voice reply from the model's final `response` text when it set
    // `voice:true` (WhatsApp dedicated only). Returns a voice response object,
    // or null to fall back to a normal text reply (limit hit, too long, error).
    const buildVoiceReply = async (rawResponseText, finalAttachments) => {
      const chatKey = getVoiceLimitChatKey(ctx);
      const spoken = sanitizeVoiceMessageText(stripOutgoingDeliveryArtifacts(rawResponseText || ''));
      if (!spoken.trim()) return null;

      const count = await getVoiceCount(userCtx, chatKey);
      if (count >= 3) {
        log.warn(`   Voice requested but limit reached in ${chatKey}; replying as text`);
        return null;
      }
      if (spoken.length > MAX_TTS_CHARS) {
        log.warn(`   Voice text too long (${spoken.length} > ${MAX_TTS_CHARS}); replying as text`);
        return null;
      }

      let voiceBuffer;
      try {
        if (ctx.presence && typeof ctx.presence.setRecording === 'function') {
          try { await ctx.presence.setRecording(); } catch { /* best effort */ }
        }
        voiceBuffer = await generateVoice(spoken);
      } catch (err) {
        log.error(`   Voice generation failed (${err.message}); replying as text`);
        return null;
      }

      await incrementVoiceCount(userCtx, chatKey);
      const researchFooter = ctx.platform === PLATFORM_WA_DEDICATED
        ? buildResearchBadgeText(responseCtx.researchStats)
        : null;
      log.info(`   Voice reply ready (${voiceBuffer.length} bytes)`);
      return {
        text: null,
        voiceBuffer,
        isVoiceOnly: true,
        attachments: finalAttachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed,
        voiceTranscriptText: spoken,
        voiceTranscriptChatId: ctx.chatId || chatKey,
        researchFooter,
      };
    };

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      if (Date.now() - sessionStartTime > SESSION_MAX_DURATION_MS) {
        log.warn('   Session duration limit reached (10 minutes), forcing wrap up');
        sessionDurationLimitReached = true;
        break;
      }

      const pLabel = (typeof ctx?.platform === 'string' && ctx.platform) ? ctx.platform.toUpperCase() : 'UNKNOWN';
      log.info(`[${pLabel}] AI call (round ${rounds}/${MAX_TOOL_ROUNDS})`);

      // Refresh the workspace listing before each AI call so any file the
      // build sub-agent just produced shows up immediately in <BuildWorkspace>.
      refreshUserWorkspace();
      reloadLongTermMemory(ctx, ui);

      // Delivery / structured-reply state for this round: drives the prompt's
      // delivery instructions and whether conversation_title is required.
      const deliveryState = computeDeliveryState();
      ctx.deliveryState = deliveryState;
      ctx.isFirstTurn = deliveryState.includeTitle;
      userCtx.isFirstTurn = deliveryState.includeTitle;
      messages[0].content = buildSystemPrompt(ctx);

      const roundTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      currentRoundTools = roundTools;
      const responseFormat = buildGemixResponseFormat({ includeTitle: deliveryState.includeTitle, allowVoice });
      const callOpts = {
        maxTurns: MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        historyStorageId: resolveStorageId(ctx) || null,
        promptCacheKey,
      };

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
        const phases = partitionHandlerToolCalls(orderedCalls);
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
        await runPhase(phases.phase2, false);

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

      // The fixed structured reply carries the user-facing text in `response`,
      // plus optional attachments, the Discord title, and (WhatsApp) the voice flag.
      const parsed = parseStructuredReply(assistantMsg.content || '');
      if (!parsed.structured) {
        log.warn('   Structured reply expected but content was not valid JSON; using raw text');
      }
      applyParsedTitle(parsed);
      const finalAttachments = await resolveFinalAttachments(parsed);

      // Voice reply (WhatsApp dedicated only): speak `response` (with TTS tags)
      // instead of sending text. Falls back to text on limit/length/TTS failure.
      if (allowVoice && parsed.voice) {
        const voiceReply = await buildVoiceReply(parsed.text || '', finalAttachments);
        if (voiceReply) return voiceReply;
        log.info('   Voice reply not produced; falling back to text');
      }

      let text = cleanAssistantResponse(parsed.text || '');
      log.info(`   [${pLabel}] Response generated (${text.length} chars, ${finalAttachments.length} attachment(s))`);

      if (!text.trim() && finalAttachments.length === 0) {
        log.warn('   Empty AI response, sending fallback');
        await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx));
        return {
          text: FALLBACK_ERROR_PREFIX,
          voiceBuffer: null,
          isVoiceOnly: false,
          attachments: [],
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
          systemMessage: true,
        };
      }

      // ── Research badge ──────────────────────────────────────────────────
      // Append "🌐: N sources. 𝕏: N posts." when server-side web/X search ran
      // (real counts from the API payloads). Omit a section when its count is
      // zero so the badge stays minimal.
      if (text.trim() && responseCtx.researchStats) {
        const badge = buildResearchBadgeText(responseCtx.researchStats);
        if (badge) {
          text = appendResearchBadge(text, responseCtx.researchStats);
          log.info(`   Research badge: ${badge}`);
        }
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

    // ── Forced text wrap-up (session wall clock or tool-round budget) ───
    const wrapUpReason = sessionDurationLimitReached
      ? 'session time limit (10 minutes)'
      : `tool-round budget (${MAX_TOOL_ROUNDS})`;
    log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);
    let wrapUpText = '';
    let wrapUpAttachments = [];
    let wrapUpVoice = false;
    try {
      reloadLongTermMemory(ctx, ui);
      const deliveryState = computeDeliveryState();
      ctx.deliveryState = deliveryState;
      ctx.isFirstTurn = deliveryState.includeTitle;
      userCtx.isFirstTurn = deliveryState.includeTitle;
      messages[0].content = buildSystemPrompt(ctx);
      const wrapUpTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      const responseFormat = buildGemixResponseFormat({ includeTitle: deliveryState.includeTitle, allowVoice });
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
        historyStorageId: resolveStorageId(ctx) || null,
        promptCacheKey,
      });
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(searchStats);
      const parsed = parseStructuredReply(finalMsg.content || '');
      applyParsedTitle(parsed);
      wrapUpAttachments = await resolveFinalAttachments(parsed);
      wrapUpVoice = Boolean(allowVoice && parsed.voice);
      wrapUpText = wrapUpVoice ? (parsed.text || '') : cleanAssistantResponse(parsed.text || '');
    } catch (wrapErr) {
      log.error(`   Forced wrap-up call failed: ${wrapErr.message}`);
    }

    // Voice wrap-up reply (WhatsApp dedicated): speak it; fall back to text.
    if (wrapUpVoice && wrapUpText.trim()) {
      const voiceReply = await buildVoiceReply(wrapUpText, wrapUpAttachments);
      if (voiceReply) return voiceReply;
      wrapUpText = cleanAssistantResponse(wrapUpText);
    }

    if (wrapUpText.trim() && responseCtx.researchStats) {
      wrapUpText = appendResearchBadge(wrapUpText, responseCtx.researchStats);
    }

    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed: ${vcErr.message}`); }
    const wrapText = wrapUpText.trim() ? wrapUpText : FALLBACK_ERROR_PREFIX;
    return {
      text: wrapText,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: wrapUpAttachments,
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed,
      systemMessage: !wrapUpText.trim(),
    };

  } catch (err) {
    const platformLabel = (typeof ctx?.platform === 'string' && ctx.platform)
      ? ctx.platform.toUpperCase().padEnd(10)
      : 'UNKNOWN   ';
    log.error(`\n❌ [${platformLabel}] HANDLER ERROR:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    try { await resetVoiceCount(ctx, getVoiceLimitChatKey(ctx)); } catch (vcErr) { log.warn(`resetVoiceCount failed in catch: ${vcErr.message}`); }

    if (isGrokCreditExhaustedError(err)) {
      return {
        text: GROK_CREDIT_EXHAUSTED_MESSAGE,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: null,
        systemMessage: true,
      };
    }

    return {
      text: FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: null,
      systemMessage: true,
    };
  } finally {
    if (pruneAfterTurn) {
      try {
        if (ctx.historyLoadIncomplete) {
          log.warn('History load incomplete: reference-based prune skipped (age-only disk sweep)');
        }
        pruneHistory(pruneAfterTurn.historyUserId, pruneAfterTurn.referenced, pruneAfterTurn.opts);
      } catch (pruneErr) {
        log.warn(`pruneHistory failed: ${pruneErr.message}`);
      }
    }
    // Drop per-call notification dedup entries so subsequent AI calls can
    // fire intermediate notifications.
    try { clearCallNotifications(ctx); } catch { /* best effort */ }
  }
}

module.exports = { handleMessage };
