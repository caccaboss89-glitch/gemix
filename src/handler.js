// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory (WA) or statute text in prompt (Discord).
//   2. Touch the per-conversation workspace activity timestamp.
//   3. Build the Responses input: static system first (byte-stable for the turn —
//      xAI prefix-cache matches from the start of input[]), then history, the
//      current user message, then the program-owned <Runtime>…</Runtime>
//      role:user item. Runtime is built once per turn and never moves, so every
//      later round only appends to input[] — never a second role:system (xAI
//      folds extra system into the head and busts progressive cache). Files
//      arrive through attachments/ingress.js: images of the current or quoted
//      message inline as base64, everything else an [Attachment: attachments/…]
//      path the model opens with read_file. Voice notes are rendered as text in
//      place — the user's with STT (<PastVoice>), GemiX's from the transcript
//      it already had (<PastVoiceReply>).
//   4. Loop: one `/v1/responses` call per round, whichever provider profile is
//      active - tool calls per round in two phases:
//      (1) standard tools parallel, (2) delivery parallel - repeat until the
//      model returns the final response or the round budget is reached. The
//      final reply is always structured JSON (response / optional attachments,
//      plus conversation_title on every Discord turn, plus a `voice` flag on
//      WA dedicated) enforced via text.format.
//      When `voice:true` (WA dedicated only), `response` is spoken via TTS.
//   5. Off Discord, turn inline citation markup into a plain source list
//      (WhatsApp renders no anchor text), apply the research badge (real web/X
//      source counts), and ship the reply back to the platform.

import { callAI  } from './ai/aiProvider.js';
import {
  pruneSeenToolMedia,
  systemItem,
  toolResultItems,
  userItem
} from './ai/responsesItems.js';
import {
  buildStaticInstructions,
  buildDynamicRuntimeContext,
  promptToolsFingerprint
} from './ai/systemPrompt.js';
import { getToolsForUser, getToolAccessError  } from './ai/tools.js';
import { buildGemixResponseFormat, parseStructuredReply  } from './ai/responseSchema.js';
import { resolveDeliverySelection  } from './utils/deliverySelection.js';
import { applyPastVoiceRepliesToHistory  } from './utils/voiceTranscripts.js';
import { projectUserVoiceMessages  } from './attachments/voiceProjection.js';
import { generateVoice  } from './tools/voiceMessage.js';
import { sanitizeVoiceMessageText  } from './utils/text.js';
import { getCapabilities, resolveProfile, toolUnavailableMessage  } from './config/platformCapabilities.js';
import { executeTool } from './tools/index.js';
import constants from './config/constants.js';
import envConfig from './config/env.js';
import { createLogger  } from './utils/logger.js';
import { appendResearchBadge, buildResearchBadgeText  } from './utils/footer.js';

import { resolveWorkspaceId  } from './utils/workspaceId.js';
import { touchActivity  } from './utils/workspaceState.js';
import { listWorkspaceFiles  } from './sandbox/workspaceFs.js';
import { readSettings, isReviewDue, markReviewed  } from './utils/settingsStore.js';
import { cleanAssistantResponse, stripOutgoingDeliveryArtifacts, renderInlineCitations  } from './utils/text.js';
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
  PER_ROUND_TOOL_LIMITS
} from './utils/toolCallExecution.js';
import { sendIntermediateNotification  } from './utils/intermediateNotification.js';
import {
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX
} from './config/systemMessages.js';
import { resolveProviderProfile } from './ai/providers/providerProfile.js';
import { providerFailureReply } from './ai/providers/errorPolicy.js';
import { notifyAdmin } from './utils/adminNotifier.js';
import { clearCallNotifications  } from './utils/notificationDedup.js';
import { wrapSystemReminder, wrapUserQuery  } from './utils/systemTags.js';

const log = createLogger('Handler');

// Total wall-clock budget for one main turn. Caps runaway tool loops even
// when the model keeps emitting tool_calls within the round limit.
const SESSION_MAX_DURATION_MS = 10 * 60 * 1000;

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'input_text')?.text || '';
  return '';
}

/** Re-read the persisted preferences so a manage_preferences call takes effect at once. */
function reloadSettings(ctx, ui) {
  if (ctx.platform === constants.PLATFORM_DISCORD) return;
  ctx.settings = readSettings(resolveSettingsFileId(ctx, ui));
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
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember)
  });
}

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle?, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId?, systemMessage? }
 */
async function handleMessage(ctx) {
  const responseCtx = {
    discordTitle: '',
    // Accumulated stats from native server-side web/X searches (main brain
    // server-side search tools) - used for the badge appended to the reply.
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
    ctx.settings = isDiscord ? null : readSettings(settingsFileId);
    // Monthly renewal notice: injected only when something is customized, and
    // recorded right away so it cannot repeat even if it goes unanswered.
    ctx.settingsReviewDue = Boolean(ctx.settings && isReviewDue(ctx.settings));
    if (ctx.settingsReviewDue) {
      try { await markReviewed(settingsFileId); }
      catch (err) { log.warn(`markReviewed failed: ${err.message}`); }
    }

    if (isDiscord) {
      ctx.rulesContext = loadRegolamento();
    }

    const userCtx = {
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

    // -- Workspace activity tracking --
    // Touch last-activity on each main turn and read <Workspace> for the
    // prompt. Read once, first level only: the Runtime block that carries it is
    // built once too, and `list_files` gives the model the rest on demand.
    const workspaceId = resolveWorkspaceId(ctx);
    ctx.userWorkspace = null;
    if (workspaceId) {
      try { touchActivity(workspaceId); }
      catch (e) { log.warn(`touchActivity failed: ${e.message}`); }
      try {
        const listing = listWorkspaceFiles(workspaceId, 30, { depth: 1 });
        if (listing.total > 0) {
          ctx.userWorkspace = {
            total: listing.total,
            files: listing.files,
            dirs: listing.dirs,
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
    const input = [systemItem(staticInstructions)];
    input[0]._staticPrefix = true;

    // GemiX voice in history is [Attachment] on assistant (no native audio parts).
    // Replace those tags in-place with <PastVoiceReply> on the assistant messages
    // (not on the current user turn). Voice platforms only (WA dedicated + personal).
    let historyForApi = Array.isArray(ctx.history) ? ctx.history : [];
    if (allowVoice && historyForApi.length > 0) {
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
    // The user's own voice notes are conversational content, not files to open:
    // every one of them becomes <PastVoice> with its transcript, in place, on
    // every platform. The audio stays in attachments/ for read_file.
    let contentForApi = ctx.content;
    try {
      const projected = await projectUserVoiceMessages(
        { history: historyForApi, current: contentForApi, storageId: resolveStorageId(ctx) }
      );
      historyForApi = projected.history;
      contentForApi = projected.current;
      if (projected.projected > 0) {
        log.info(`   Rendered ${projected.projected} user voice note(s) as <PastVoice>`);
      }
    } catch (voiceErr) {
      log.warn(`PastVoice projection failed: ${voiceErr.message}`);
    }

    if (historyForApi.length > 0) {
      input.push(...historyForApi);
    }

    // The whole burst is a single item (utils/batchContentRefresh), tagged so the
    // model knows which request it is answering. The tag is the one deliberate
    // break in the cross-turn prefix: next turn the history replays these same
    // messages untagged and separate, so the shared prefix now ends where this
    // turn's burst began instead of at the Runtime block below.
    input.push(userItem(wrapUserQuery(contentForApi)));

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
    input.push(userItem(buildDynamicRuntimeContext(ctx)));

    /** Keep input[0] in sync if the static prefix is rebuilt mid-turn. */
    const syncStaticPrefix = () => {
      if (input[0] && input[0]._staticPrefix) {
        input[0].content = [{ type: 'input_text', text: staticInstructions }];
      } else {
        const item = systemItem(staticInstructions);
        item._staticPrefix = true;
        input.unshift(item);
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
    const sessionStartTime = Date.now();
    let sessionDurationLimitReached = false;
    const promptCacheKey = generatePromptCacheKey(userCtx);

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

    // Non-empty conversation_title → rename; "" / missing → leave thread name as-is.
    const applyParsedTitle = (parsed) => {
      if (!parsed.title) return;
      const title = sanitizeDiscordThreadTitle(stripOutgoingDeliveryArtifacts(parsed.title));
      if (!title) return;
      responseCtx.discordTitle = title;
    };

    // Tool defs for the round in flight (platform/membership-gated; what the
    // model may reach for is decided here, never re-derived per call).
    let currentRoundTools = [];

    const runToolCall = async (tc) => {
      try {
        log.info(`   Executing: ${tc.name} args=${tc.arguments || '{}'}`);
        const { toolCallId, result } = await executeTool(
          { id: tc.id, function: { name: tc.name, arguments: tc.arguments } },
          userCtx, responseCtx, deliveryCtx, currentRoundTools
        );
        const resultLog = Array.isArray(result) || typeof result === 'object'
          ? JSON.stringify(result)
          : String(result ?? '');
        log.info(`   Result: ${resultLog}`);
        return toolResultItems(toolCallId, result);
      } catch (toolErr) {
        log.error(`   ❌ Tool error "${tc.name}": ${toolErr.message}`);
        return toolResultItems(tc.id, JSON.stringify({
          success: false,
          error: `Execution error: ${toolErr.message}`
        }));
      }
    };

    // Generate a voice reply from the model's final `response` text when it set
    // `voice:true` (WhatsApp dedicated only). Returns a voice response object,
    // or null to fall back to a normal text reply (too long, error).
    const buildVoiceReply = async (rawResponseText, finalAttachments) => {
      const spoken = sanitizeVoiceMessageText(stripOutgoingDeliveryArtifacts(rawResponseText || ''));
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
        voiceBuffer = await generateVoice(spoken, ctx.settings || {});
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

      if (Date.now() - sessionStartTime > SESSION_MAX_DURATION_MS) {
        log.warn('   Session duration limit reached (10 minutes), forcing wrap up');
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
        allowVoice
      });
      const callOpts = {
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort
      };

      const { reply, provider, model, searchStats } = await callAI(input, roundTools, callOpts);
      lastModelUsed = model;
      accumulateSearchStats(searchStats);
      log.info(`   Provider: ${provider} (${model})`);

      if (reply.toolCalls.length > 0) {
        log.info(`[${pLabel}] ${reply.toolCalls.length} tool call(s)`);
        // The model's own output goes back verbatim — reasoning, message and
        // function_call items in the order it produced them. Replaying the
        // encrypted reasoning is what keeps the next round's thinking continuous.
        input.push(...reply.items);

        const orderedCalls = reply.toolCalls;
        // The set the model was actually offered this round: membership in it is
        // the whole permission check (see ai/tools.js getToolAccessError).
        const allowedToolNames = new Set(roundTools.map(t => t.function?.name).filter(Boolean));
        const phases = partitionHandlerToolCalls(orderedCalls);
        const resultsById = new Map();

        const recordToolResult = async (tc, blockedOncePerRound) => {
          if (blockedOncePerRound.has(tc.id)) {
            const cap = PER_ROUND_TOOL_LIMITS[tc.name];
            log.warn(`   Tool "${tc.name}" blocked: per-round cap (${cap}) exceeded in same model turn`);
            return toolResultItems(tc.id, perRoundCapErrorPayload(tc.name, cap));
          }
          const toolBlock = getToolAccessError(
            tc.name,
            allowedToolNames,
            (name) => _toolNotAvailableMessage(name, ctx)
          );
          if (toolBlock) {
            log.warn(`   Tool "${tc.name}" blocked: ${toolBlock}`);
            return toolResultItems(tc.id, JSON.stringify({ success: false, error: toolBlock }));
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

        // Every call answered, in the order the model made them: a
        // function_call with no output back is a malformed conversation.
        for (const tc of orderedCalls) {
          const items = resultsById.get(tc.id);
          if (items) input.push(...items);
        }

        // A file or image preview a tool attached is worth its tokens on the
        // round it arrives and not after; the envelope stays either way.
        pruneSeenToolMedia(input);

        continue;
      }

      // The fixed structured reply carries the user-facing text in `response`,
      // plus optional attachments, the Discord title, and (WhatsApp) the voice flag.
      const parsed = parseStructuredReply(reply.text || '');
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
          if (reply.items.length > 0) input.push(...reply.items);
          input.push(userItem(wrapSystemReminder(
            'Your previous output was empty: no tool call and no structured reply. '
            + 'Immediately call any tools you need (e.g. web_image_search for web photos) '
            + 'or send a valid structured reply. Never leave the reply empty.'
          )));
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
        allowVoice
      });
      const wrapUpNote = sessionDurationLimitReached
        ? 'This turn hit the maximum session duration. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      input.push(userItem(wrapSystemReminder(wrapUpNote)));
      const { reply: finalReply, model: finalModel, searchStats } = await callAI(input, wrapUpTools, {
        toolChoice: 'none',
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort
      });
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(searchStats);
      const parsed = parseStructuredReply(finalReply.text || '');
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

    // A typed refusal from the provider (spent allowance, throttling, bad
    // credentials) is an already-handled state, not a crash: the error policy
    // picks the copy for the active profile and no stack trace is logged.
    const providerReply = providerFailureReply(err, resolveProviderProfile());
    if (providerReply) {
      log.warn(`   [${platformLabel.trim()}] ${providerReply.logLine}`);
      if (providerReply.notifyAdmin) {
        await notifyAdmin('AI Provider', `${err.kind}: ${err.message}`).catch(() => {});
      }
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
  }
}

export { handleMessage
};
