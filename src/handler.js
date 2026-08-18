// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory (WA) or statute text in prompt (Discord).
//   2. Touch the per-user/group build workspace activity timestamp (WA only).
//   3. Build chat messages: static system first (byte-stable for the turn —
//      xAI prefix-cache matches from the start of input[]), then history, the
//      current user message, then the program-owned <Runtime>…</Runtime>
//      role:user item. Runtime is built once per turn and never moves, so every
//      later round only appends to input[] — never a second role:system (xAI
//      folds extra system into the head and busts progressive cache). Media uses
//      utils/incomingMediaIngress.js → aiFileDelivery.js: native `input_image`
//      / `input_file` parts via public URLs (user/history files attached
//      natively; assistant-side entries including GemiX voice stay [Attachment]
//      tags only), or tag-only for raw binaries. GemiX past voice transcripts
//      replace assistant [Attachment: …] tags in history with <PastVoiceReply>
//      (WA voice platforms).
//   4. Loop: call Grok (`/v1/responses`) - tool calls per round in two phases:
//      (1) standard tools parallel, (2) delivery parallel - repeat until the
//      model returns the final response or the round budget is reached. The
//      final reply is always structured JSON (response / optional attachments,
//      plus conversation_title on Discord first turn only, plus a `voice`
//      flag on WA dedicated) enforced via text.format.
//      When `voice:true` (WA dedicated only), `response` is spoken via TTS.
//   5. Project the turn's citations into the shared inline shape, off Discord
//      turn them into a plain source list (WhatsApp renders no anchor text),
//      apply the research badge (real search counts), and ship the reply back
//      to the platform.

import { callAI  } from './ai/aiProvider.js';
import { resolveProviderProfile  } from './ai/providers/providerProfile.js';
import {
  buildStaticInstructions,
  buildDynamicRuntimeContext,
  promptToolsFingerprint
} from './ai/systemPrompt.js';
import { getToolsForUser, getToolAccessError  } from './ai/tools.js';
import { buildGemixResponseFormat, parseStructuredReply  } from './ai/responseSchema.js';
import { resolveDeliverySelection  } from './utils/deliverySelection.js';
import { createImageRegistry, registerUserUrls  } from './utils/imageRegistry.js';
import { summarizeToolArguments, summarizeToolResult  } from './utils/safeToolLogging.js';
import { applyPastVoiceRepliesToHistory  } from './utils/voiceTranscripts.js';
import { projectUserVoiceMessages  } from './utils/voiceMessageProjection.js';
import { generateVoice, spokenTextForProvider  } from './tools/voiceMessage.js';
import { sanitizeVoiceMessageText  } from './utils/text.js';
import { getCapabilities, resolveProfile, toolUnavailableMessage  } from './config/platformCapabilities.js';
import { executeTool } from './tools/index.js';
import constants from './config/constants.js';
import envConfig from './config/env.js';
import { createLogger  } from './utils/logger.js';
import { appendResearchBadge, buildResearchBadgeText, mergeResearchStats  } from './utils/footer.js';

import { resolveWorkspaceId  } from './utils/workspaceId.js';
import { touchActivity  } from './utils/buildState.js';
import { listWorkspaceFiles  } from './sandbox/buildWorkspace.js';
import { readSettings, isReviewDue, markReviewed  } from './utils/settingsStore.js';
import { cleanAssistantResponse, stripOutgoingDeliveryArtifacts, applyCitationAnnotations, renderInlineCitations  } from './utils/text.js';
import { sanitizeDiscordThreadTitle  } from './utils/discord.js';
import { loadRegolamento  } from './utils/regolamento.js';
import { resolveStorageId, resolveSettingsFileId  } from './utils/userPaths.js';
import { generatePromptCacheKey  } from './utils/promptCacheKey.js';
import { pruneHistory, collectReferencedHistoryFilenames, DISCORD_MAX_AGE_MS  } from './utils/historySync.js';
import { enableReleaseNotify  } from './tools/releaseNotify.js';
import { sendWhatsAppDirect  } from './tools/whatsappSender.js';
import {
  partitionHandlerToolCalls,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
  PER_ROUND_TOOL_LIMITS,
  ToolCallLedger
} from './utils/toolCallExecution.js';
import { sendIntermediateNotification  } from './utils/intermediateNotification.js';
import {
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX
} from './config/systemMessages.js';
import { providerFailureReply  } from './ai/providers/errorPolicy.js';
import { clearCallNotifications  } from './utils/notificationDedup.js';
import { wrapSystemReminder, wrapUserQuery  } from './utils/systemTags.js';
import { TurnBudget  } from './utils/turnBudget.js';

const log = createLogger('Handler');

// Total wall-clock budget for one main turn. Caps runaway tool loops even
// when the model keeps emitting tool_calls within the round limit.
const SESSION_MAX_DURATION_MS = 10 * 60 * 1000;
const SESSION_MAX_DURATION_MIN = SESSION_MAX_DURATION_MS / 60_000;

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'text')?.text || '';
  return '';
}

/** Re-read the persisted preferences so a manage_preferences call takes effect at once. */
function reloadSettings(ctx, ui) {
  if (ctx.platform === constants.PLATFORM_DISCORD) return;
  ctx.settings = readSettings(resolveSettingsFileId(ctx, ui), ctx);
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

function _toolNotAvailableMessage(toolName, ctx) {
  return toolUnavailableMessage(toolName, resolveProfile(ctx), {
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember),
    providerProfile: ctx.providerProfile
  });
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle?, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId?, systemMessage? }
 */
async function handleMessage(ctx) {
  // Resolved once and captured immutably for the whole turn: prompt, tools,
  // schema, media projection, dispatcher and Build all read this same object,
  // so nothing downstream re-derives the provider from a model slug or a URL.
  const providerProfile = resolveProviderProfile();
  ctx.providerProfile = providerProfile;

  // The same wall-clock ceiling the round loop has always had, as one object
  // threaded like the profile above. Reading it only between rounds was never
  // enough on its own: a round already in flight ran to its own timeout no
  // matter how long the turn had taken. Every call in the loop now derives its
  // timeout and its abort signal from this one deadline. The forced wrap-up is
  // the deliberate exception — see where it is built.
  const turnBudget = new TurnBudget(SESSION_MAX_DURATION_MS);
  ctx.turnBudget = turnBudget;

  const responseCtx = {
    attachments: [],
    discordTitle: '',
    providerProfile,
    turnBudget,
    // Allowlist of the image URLs this turn is allowed to deliver. Filled from
    // structured search results and from what the user wrote, never from text
    // the model produced.
    imageRegistry: createImageRegistry(),
    // Accumulated stats from server-side web (and, on xAI, X) searches — main
    // brain and build sub-agent — used for the badge appended to the reply.
    researchStats: null
  };

  let pruneAfterTurn = null;
  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = Boolean(ui.isAdmin);
    let maintenanceCommand = extractPlainTextContent(ctx.content).trim().toLowerCase();

    // Extract command from formatted message: [DATE, TIME] UserName: /command ...
    // Find the colon right after the "]" (the username separator, not one that
    // may appear inside the message body itself) and extract the first token after it.
    const bracketEndIdx = maintenanceCommand.indexOf(']');
    const separatorColonIdx = bracketEndIdx !== -1
      ? maintenanceCommand.indexOf(':', bracketEndIdx)
      : -1;
    if (separatorColonIdx !== -1) {
      const afterColon = maintenanceCommand.substring(separatorColonIdx + 1).trim();
      const firstToken = afterColon.split(/\s+/)[0];
      if (firstToken) {
        maintenanceCommand = firstToken;
      }
    }

    const releaseNotifyTarget = getReleaseNotifyTarget(ctx, ui);

    // -- Maintenance gate --
    // Blocks every non-admin request with a fixed message. Admins always pass.
    if (envConfig.MAINTENANCE_MODE && constants.MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      if (maintenanceCommand === constants.MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
        const enableResult = enableReleaseNotify(releaseNotifyTarget.chatId, releaseNotifyTarget.waJid);
        const alreadyEnabled = Boolean(enableResult.alreadyEnabled);
        const text = alreadyEnabled
          ? buildMaintenanceReleaseAlreadyEnabledMessage()
          : buildMaintenanceReleaseEnabledMessage();
        if (ctx.platform === constants.PLATFORM_DISCORD && releaseNotifyTarget.waJid) {
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
          systemMessage: true
        };
      }
      log.info(`   Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      return {
        text: constants.MAINTENANCE_USER_MESSAGE,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: '',
        modelUsed: null,
        systemMessage: true
      };
    }

    const isDiscord = ctx.platform === constants.PLATFORM_DISCORD;
    // Voice replies are a structured-reply flag (WhatsApp dedicated only),
    // never a tool. The model sets `voice:true` and writes `response` with TTS tags.
    const allowVoice = Boolean(getCapabilities(ctx).voiceReply);
    const settingsFileId = resolveSettingsFileId(ctx, ui);

    // Per-chat preferences drive the prompt's <CurrentSettings>, the reasoning
    // effort, and the TTS voice/language.
    ctx.settings = isDiscord ? null : readSettings(settingsFileId, ctx);
    // Monthly renewal notice: injected only when something is customized, and
    // recorded right away so it cannot repeat even if it goes unanswered.
    ctx.settingsReviewDue = Boolean(ctx.settings && isReviewDue(ctx.settings, Date.now(), ctx));
    if (ctx.settingsReviewDue) {
      try { await markReviewed(settingsFileId, ctx); }
      catch (err) { log.warn(`markReviewed failed: ${err.message}`); }
    }

    if (isDiscord) {
      ctx.rulesContext = loadRegolamento();
    }

    const userCtx = {
      providerProfile,
      isActiveMember,
      isAdmin: userIsAdmin,
      member: ui.member,
      taskFileId: ui.taskFileId,
      settingsFileId,
      userId: ctx.userId,
      userName: ctx.userName,
      waJid: ctx.waJid || (ui.member ? ui.member.wa : null),
      email: ui.member ? ui.member.email : null,
      isGroup: ctx.isGroup,
      groupId: ctx.groupId,
      chatId: ctx.chatId || null,
      platform: ctx.platform,
      requestId: `${ctx.platform || 'unknown'}:${ctx.chatId || ctx.userId || 'unknown'}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
      presence: ctx.presence || null,
      // Bound helper for tools that want to fire an intermediate notification
      // (e.g. build - "Sto delegando il lavoro al coder agent...").
      // Dedup is enforced per (call, kind) inside sendIntermediateNotification.
      sendIntermediateNotification: (kind, message) => sendIntermediateNotification(ctx, kind, message)
    };

    // ctx.requestId is set here so that sendIntermediateNotification (which
    // receives ctx, not userCtx) uses the same call-scoped ID as the dedup
    // keys written by the tools dispatcher (which receives userCtx).
    ctx.requestId = userCtx.requestId;

    // -- Build workspace activity tracking (WhatsApp only) --
    // Touch last-activity on each main turn and read <BuildWorkspace> for the
    // prompt. Read once: the Runtime block that carries it is built once too,
    // and the build tool reports the files it produces in its own result.
    const workspaceId = isDiscord ? null : resolveWorkspaceId(ctx);
    ctx.userWorkspace = null;
    if (workspaceId) {
      try { touchActivity(workspaceId); }
      catch (e) { log.warn(`touchActivity failed: ${e.message}`); }
      try {
        const listing = listWorkspaceFiles(workspaceId, 30);
        if (listing.total > 0) {
          ctx.userWorkspace = {
            total: listing.total,
            files: listing.files,
            more: !!listing.more
          };
        }
      } catch (e) {
        log.warn(`listWorkspaceFiles failed: ${e.message}`);
      }
    }

    // Static system first (only role:system — keep it that way for prefix
    // cache). Then history, the current user message, and the Runtime block.
    // Rebuilt static only if the live tool fingerprint changes mid-turn (rare).
    let staticInstructions = buildStaticInstructions(ctx);
    let toolsFp = promptToolsFingerprint(ctx);
    const messages = [{
      role: 'system',
      content: staticInstructions,
      _staticPrefix: true
    }];

    // GemiX voice in history is [Attachment] on assistant (no native audio parts).
    // Replace those tags in-place with <PastVoiceReply> on the assistant messages
    // (not on the current user turn). Independent of allowVoice: the text is
    // already known, so the model must still see what it said even when voice
    // replies are momentarily unavailable.
    let historyForApi = Array.isArray(ctx.history) ? ctx.history : [];
    if (historyForApi.length > 0) {
      try {
        const { history: patched, replacedCount } = applyPastVoiceRepliesToHistory(
          historyForApi,
          resolveStorageId(ctx)
        );
        historyForApi = patched;
        if (replacedCount > 0) {
          log.info(`   Replaced ${replacedCount} assistant voice [Attachment] tag(s) with <PastVoiceReply>`);
        }
      } catch (txErr) {
        log.warn(`PastVoiceReply history rewrite failed: ${txErr.message}`);
      }
    }

    // Providers whose main model cannot hear audio read user voice notes as
    // text. One transformation on the copy used for this call covers current,
    // reply and history alike; the originals keep their [Attachment] tags, so
    // pruning and the on-disk files are unaffected.
    let currentContent = ctx.content;
    if (getCapabilities(ctx).userVoiceTranscription) {
      try {
        const projected = await projectUserVoiceMessages(
          { history: historyForApi, current: currentContent, storageId: resolveStorageId(ctx) },
          { language: ctx.settings?.language, signal: turnBudget.signal }
        );
        historyForApi = projected.history;
        currentContent = projected.current;
        if (projected.projected > 0) {
          log.info(`   Projected ${projected.projected} user voice note(s) as <VoiceMessage>`);
        }
      } catch (sttErr) {
        log.warn(`Voice note projection failed: ${sttErr.message}`);
      }
    }

    if (historyForApi.length > 0) {
      messages.push(...historyForApi);
    }

    // The whole burst is a single item (utils/batchContentRefresh), tagged so the
    // model knows which request it is answering. The tag is the one deliberate
    // break in the cross-turn prefix: next turn the history replays these same
    // messages untagged and separate, so the shared prefix now ends where this
    // turn's burst began instead of at the Runtime block below.
    messages.push({ role: 'user', content: wrapUserQuery(currentContent) });

    // A link the user sent themselves stays deliverable under the normal
    // attachment contract, so it joins the allowlist alongside search results.
    registerUserUrls(responseCtx.imageRegistry, extractPlainTextContent(currentContent));

    // Turn-varying program state: built once, placed right after the current
    // user message, and never moved again. Both constraints matter.
    //   - after the user message, so that nothing turn-varying lands where the
    //     history will replay a message next turn.
    //   - never rebuilt or re-appended, because then each round would drop
    //     changing bytes where the replayed reasoning and tool items land and
    //     force a recompute from there on.
    // Together they keep every round a pure append, which is the cache that
    // actually holds (87-89% within a turn).
    // Must not use role:system either: xAI merges extra system messages into the
    // leading system block, which moves them and busts the prefix for good.
    // What it states can move during the turn (build workspace, quota counts,
    // preferences); the tool results that cause those changes report them, so
    // the frozen snapshot stays truthful about turn start.
    messages.push({ role: 'user', content: buildDynamicRuntimeContext(ctx) });

    /** Keep messages[0] in sync if the static prefix is rebuilt mid-turn. */
    const syncStaticPrefix = () => {
      if (messages[0] && messages[0]._staticPrefix) {
        messages[0].content = staticInstructions;
      } else {
        messages.unshift({
          role: 'system',
          content: staticInstructions,
          _staticPrefix: true
        });
      }
    };

    try {
      const historyUserId = resolveStorageId(ctx);
      if (historyUserId) {
        if (ctx.historyLoadIncomplete) {
          pruneAfterTurn = {
            historyUserId,
            referenced: new Set(),
            opts: { maxAgeMs: DISCORD_MAX_AGE_MS, ageOnly: true }
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

    // One outbound message per destination per turn (per-round tool caps are
    // enforced upstream by perRoundCappedDuplicateIds).
    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set()
    };

    let rounds = 0;
    // xAI sometimes returns completed+reasoning with no message/tool_calls.
    // One extra attempt only — do not burn the full tool-round budget.
    let emptyOutputRetries = 0;
    const MAX_EMPTY_OUTPUT_RETRIES = 1;
    let lastModelUsed = null;
    // Citations of the round that produced the reply the user actually reads.
    let roundCitations = [];
    let sessionDurationLimitReached = false;
    const promptCacheKey = generatePromptCacheKey(userCtx);

    const accumulateSearchStats = (searchStats) => {
      responseCtx.researchStats = mergeResearchStats(responseCtx.researchStats, searchStats);
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

    // Providers that report citations as annotations instead of writing them
    // into the reply get them projected into the shared inline shape here,
    // before the reply splits into the voice and text branches. No citations
    // (the xAI path, which renders its own) leaves the text untouched.
    const applyParsedCitations = (parsed) => {
      parsed.text = applyCitationAnnotations(parsed.text || '', roundCitations);
    };

    // Non-empty conversation_title → rename; "" / missing → leave thread name as-is.
    const applyParsedTitle = (parsed) => {
      if (!parsed.title) return;
      const title = sanitizeDiscordThreadTitle(stripOutgoingDeliveryArtifacts(parsed.title));
      if (!title) return;
      responseCtx.discordTitle = title;
    };

    // Tool defs for the round in flight (platform/membership-gated; delivery
    // buffer state is injected into the Runtime block, not into tool schemas).
    let currentRoundTools = [];

    // One tool call id executes once per turn, whatever brings it back.
    const toolLedger = new ToolCallLedger();

    const executeToolCall = async (tc) => {
      try {
        // Metadata only: arguments and results carry prompts, message bodies,
        // file contents and inline base64, none of which belongs in a log.
        log.info(`   Executing: ${tc.function.name} ${summarizeToolArguments(tc.function.arguments)}`);
        const { toolCallId, result } = await executeTool(tc, userCtx, responseCtx, deliveryCtx, currentRoundTools);
        log.info(`   Result: ${summarizeToolResult(result)}`);
        return {
          role: 'tool',
          tool_call_id: toolCallId,
          content: result
        };
      } catch (toolErr) {
        log.error(`   ❌ Tool error "${tc.function.name}": ${toolErr.message}`);
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ success: false, error: `Execution error: ${toolErr.message}` })
        };
      }
    };

    const runToolCall = (tc) => toolLedger.run(tc, () => executeToolCall(tc), (why) => log.warn(`   ${why}`));

    // Generate a voice reply from the model's final `response` text when it set
    // `voice:true` (WhatsApp dedicated only). Returns a voice response object,
    // or null to fall back to a normal text reply (too long, error).
    const buildVoiceReply = async (rawResponseText, finalAttachments) => {
      const sanitized = sanitizeVoiceMessageText(stripOutgoingDeliveryArtifacts(rawResponseText || ''));
      const spoken = spokenTextForProvider(sanitized, ctx);
      if (!spoken.trim()) return null;

      if (spoken.length > constants.MAX_TTS_CHARS) {
        log.warn(`   Voice text too long (${spoken.length} > ${constants.MAX_TTS_CHARS}); replying as text`);
        return null;
      }

      let voiceBuffer;
      try {
        if (ctx.presence && typeof ctx.presence.setRecording === 'function') {
          try { await ctx.presence.setRecording(); } catch { /* best effort */ }
        }
        voiceBuffer = await generateVoice(spoken, ctx.settings || {}, ctx);
      } catch (err) {
        log.error(`   Voice generation failed (${err.message}); replying as text`);
        return null;
      }

      const researchFooter = ctx.platform === constants.PLATFORM_WA_DEDICATED
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
        voiceTranscriptChatId: ctx.chatId || ctx.groupId || null,
        researchFooter
      };
    };

    while (rounds < constants.MAX_TOOL_ROUNDS) {
      rounds++;

      if (turnBudget.expired) {
        log.warn(`   Session duration limit reached (${SESSION_MAX_DURATION_MIN} minutes), forcing wrap up`);
        sessionDurationLimitReached = true;
        break;
      }

      const pLabel = (typeof ctx?.platform === 'string' && ctx.platform) ? ctx.platform.toUpperCase() : 'UNKNOWN';
      log.info(`[${pLabel}] AI call (round ${rounds}/${constants.MAX_TOOL_ROUNDS})`);

      // Pick up a manage_preferences change for this call's reasoning effort.
      // Static prefix stays byte-identical unless the tool fingerprint changes.
      reloadSettings(ctx, ui);

      const roundTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      currentRoundTools = roundTools;
      const nextFp = promptToolsFingerprint(ctx);
      if (nextFp !== toolsFp) {
        // Unexpected today (getToolsForUser depends on nothing that moves mid-turn);
        // keep it correct in case gating ever changes.
        staticInstructions = buildStaticInstructions(ctx);
        toolsFp = nextFp;
        syncStaticPrefix();
        log.info('   Static system prefix rebuilt (tool fingerprint changed mid-turn)');
      }

      // Discord: conversation_title only on first turn (required); later turns
      // omit it so the model cannot rename mid-conversation.
      const responseFormat = buildGemixResponseFormat({
        includeTitle: isDiscord,
        allowVoice,
        providerProfile
      });
      const callOpts = {
        providerProfile,
        turnBudget,
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        historyStorageId: resolveStorageId(ctx) || null,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort
      };

      const { message: assistantMsg, provider, model, searchStats, citations } = await callAI(messages, roundTools, callOpts);
      lastModelUsed = model;
      accumulateSearchStats(searchStats);
      roundCitations = Array.isArray(citations) ? citations : [];
      log.info(`   Provider: ${provider} (${model})`);

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        log.info(`[${pLabel}] ${assistantMsg.tool_calls.length} tool call(s)`);
        // OpenAI-compatible reasoning models occasionally return content=null
        // - drop it so the message validates downstream.
        if (assistantMsg.content === null || assistantMsg.content === undefined) {
          delete assistantMsg.content;
        }
        messages.push(assistantMsg);

        const orderedCalls = assistantMsg.tool_calls;
        // The set the model was actually offered this round: membership in it is
        // the whole permission check (see ai/tools.js getToolAccessError).
        const allowedToolNames = new Set(roundTools.map(t => t.function?.name).filter(Boolean));
        const phases = partitionHandlerToolCalls(orderedCalls);
        const resultsById = new Map();

        const recordToolResult = async (tc, blockedOncePerRound) => {
          if (blockedOncePerRound.has(tc.id)) {
            const name = tc.function?.name || 'tool';
            const cap = PER_ROUND_TOOL_LIMITS[name];
            log.warn(`   Tool "${name}" blocked: per-round cap (${cap}) exceeded in same model turn`);
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: perRoundCapErrorPayload(name, cap)
            };
          }
          const toolBlock = getToolAccessError(
            tc.function.name,
            allowedToolNames,
            (name) => _toolNotAvailableMessage(name, ctx)
          );
          if (toolBlock) {
            log.warn(`   Tool "${tc.function.name}" blocked: ${toolBlock}`);
            return {
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify({ success: false, error: toolBlock })
            };
          }
          return runToolCall(tc);
        };

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
      applyParsedCitations(parsed);
      const finalAttachments = await resolveFinalAttachments(parsed);

      // Voice reply (WhatsApp dedicated only): speak `response` (with TTS tags)
      // instead of sending text. Falls back to text on limit/length/TTS failure.
      if (allowVoice && parsed.voice) {
        const voiceReply = await buildVoiceReply(parsed.text || '', finalAttachments);
        if (voiceReply) return voiceReply;
        log.info('   Voice reply not produced; falling back to text');
      }

      let text = cleanAssistantResponse(parsed.text || '');
      if (!isDiscord) text = renderInlineCitations(text);
      log.info(`   [${pLabel}] Response generated (${text.length} chars, ${finalAttachments.length} attachment(s))`);

      // xAI occasionally returns status=completed with only a reasoning item
      // (no function_call, no message/output_text). At most one retry; if it
      // still returns empty (or the API is 503-flaky), fall back immediately —
      // do not spin through all constants.MAX_TOOL_ROUNDS.
      if (!text.trim() && finalAttachments.length === 0) {
        if (emptyOutputRetries < MAX_EMPTY_OUTPUT_RETRIES && rounds < constants.MAX_TOOL_ROUNDS) {
          emptyOutputRetries += 1;
          log.warn(
            '   Empty model output (no tool call, no structured reply) — one retry '
            + `(${emptyOutputRetries}/${MAX_EMPTY_OUTPUT_RETRIES})`
          );
          if (Array.isArray(assistantMsg._responsesOutput) && assistantMsg._responsesOutput.length > 0) {
            messages.push(assistantMsg);
          }
          messages.push({
            role: 'user',
            content: wrapSystemReminder(
              'Your previous output was empty: no tool call and no structured reply. '
              + 'Immediately call any tools you need (e.g. web_image_search for web photos) '
              + 'or send a valid structured reply. Never leave the reply empty.'
            )
          });
          continue;
        }
        log.warn(
          emptyOutputRetries > 0
            ? '   Empty AI response after retry, sending fallback'
            : '   Empty AI response, sending fallback'
        );
        return {
          text: FALLBACK_ERROR_PREFIX,
          voiceBuffer: null,
          isVoiceOnly: false,
          attachments: [],
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed,
          systemMessage: true
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

      return {
        text: text || null,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: finalAttachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed
      };
    }

    // ── Forced text wrap-up (session wall clock or tool-round budget) ───
    const wrapUpReason = sessionDurationLimitReached
      ? 'session time limit (10 minutes)'
      : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`;
    log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);
    let wrapUpText = '';
    let wrapUpAttachments = [];
    let wrapUpVoice = false;
    try {
      reloadSettings(ctx, ui);
      const wrapUpTools = getToolsForUser(isActiveMember, userIsAdmin, userCtx);
      const nextFp = promptToolsFingerprint(ctx);
      if (nextFp !== toolsFp) {
        staticInstructions = buildStaticInstructions(ctx);
        toolsFp = nextFp;
        syncStaticPrefix();
      }
      const responseFormat = buildGemixResponseFormat({
        includeTitle: isDiscord,
        allowVoice,
        providerProfile
      });
      const wrapUpNote = sessionDurationLimitReached
        ? 'This turn hit the maximum session duration. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      messages.push({
        role: 'user',
        content: wrapSystemReminder(wrapUpNote)
      });
      // Deliberately its own window rather than a slice of the turn: the loop
      // usually reaches here precisely because the turn is spent, and a wrap-up
      // born expired would hand every long turn the generic failure text
      // instead of the answer the model already has. It runs no tools, so this
      // is one bounded call, not another round.
      const wrapUpBudget = new TurnBudget(constants.API_TIMEOUT_MS);
      let finalMsg, finalModel, searchStats, citations;
      try {
        ({ message: finalMsg, model: finalModel, searchStats, citations } = await callAI(messages, wrapUpTools, {
          providerProfile,
          turnBudget: wrapUpBudget,
          toolChoice: 'none',
          requestId: ctx.requestId,
          responseFormat,
          historyStorageId: resolveStorageId(ctx) || null,
          promptCacheKey,
          reasoningEffort: ctx.settings?.effort
        }));
      } finally {
        wrapUpBudget.dispose();
      }
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(searchStats);
      roundCitations = Array.isArray(citations) ? citations : [];
      const parsed = parseStructuredReply(finalMsg.content || '');
      applyParsedTitle(parsed);
      applyParsedCitations(parsed);
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
    if (!isDiscord) wrapUpText = renderInlineCitations(wrapUpText);

    if (wrapUpText.trim() && responseCtx.researchStats) {
      wrapUpText = appendResearchBadge(wrapUpText, responseCtx.researchStats);
    }

    const wrapText = wrapUpText.trim() ? wrapUpText : FALLBACK_ERROR_PREFIX;
    return {
      text: wrapText,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: wrapUpAttachments,
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed,
      systemMessage: !wrapUpText.trim()
    };

  } catch (err) {
    const platformLabel = (typeof ctx?.platform === 'string' && ctx.platform)
      ? ctx.platform.toUpperCase().padEnd(10)
      : 'UNKNOWN   ';

    // A refusal the back end owns — the SuperGrok weekly cap on xAI, a typed
    // quota/auth failure on OpenAI — is an expected, already-handled state:
    // reply with that profile's notice, no admin alert and no red stack trace.
    const providerReply = providerFailureReply(err, providerProfile);
    if (providerReply) {
      log.warn(`   [${platformLabel.trim()}] ${providerReply.logLine}`);
      return {
        text: providerReply.text,
        voiceBuffer: null,
        isVoiceOnly: false,
        attachments: [],
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: null,
        systemMessage: true
      };
    }

    log.error(`\n❌ [${platformLabel}] HANDLER ERROR:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);

    return {
      text: FALLBACK_ERROR_PREFIX,
      voiceBuffer: null,
      isVoiceOnly: false,
      attachments: [],
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: null,
      systemMessage: true
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
    // Release the deadline timer: the turn is over either way.
    turnBudget.dispose();
  }
}

export { handleMessage
};
