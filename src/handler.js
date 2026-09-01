// src/handler.js
//
// Main message handler.
//
// One round of conversation looks like this:
//   1. Resolve identity / memory (WA) or statute text in prompt (Discord).
//   2. Touch the per-conversation workspace activity timestamp.
//   3. Build the Responses input: static system first (byte-stable for the turn —
//      Responses endpoints can cache it from the start of input[]), then history, the
//      current user message, then the program-owned <Runtime>…</Runtime>
//      role:user item. Runtime is built once per turn and never moves, so every
//      later round only appends to input[] — never a second role:system. Files
//      arrive through attachments/ingress.js: images of the current or quoted
//      message inline as base64, everything else an [Attachment: attachments/…]
//      path the model opens with read_file. Voice notes are rendered as text in
//      place — the user's with STT (<PastVoice>), GemiX's from the transcript
//      it already had (<PastVoiceReply>).
//   4. Loop: one `/v1/responses` call per round, whichever provider profile is
//      active. Consecutive read-only tool calls run with bounded concurrency;
//      mutations, shell, generators and deliveries remain serial barriers in
//      the model's original order. Repeat until the model returns the final
//      response or the round budget is reached. The
//      final reply is always structured JSON (response / nullable attachments,
//      plus conversation_title on every Discord turn, plus a `voice` flag on
//      WA dedicated) enforced via text.format.
//      When `voice:true` (WA dedicated only), `response` is spoken via TTS.
//   5. Apply the research badge from per-turn GemiX web / native X counters,
//      then ship the reply back to the platform.

import { callAI  } from './ai/aiProvider.js';
import { withApiLogConversation } from './ai/apiLogs.js';
import {
  pruneSeenToolMedia,
  systemItem,
  userItem
} from './ai/responsesItems.js';
import {
  buildStaticInstructions,
  toolsFingerprint
} from './ai/systemPrompt.js';
import { prepareTurn, reloadSettings } from './ai/turnPreparation.js';
import { executeToolRound } from './ai/toolRoundController.js';
import {
  accumulateSearchStats,
  applyParsedTitle,
  buildVoiceReply,
  resolveFinalAttachments
} from './ai/turnReply.js';
import { getToolsForUser  } from './ai/tools.js';
import { buildGemixResponseFormat, parseStructuredReply  } from './ai/responseSchema.js';
import constants from './config/constants.js';
import { createTurnBudgets, turnBudgetFrom } from './utils/turnBudget.js';
import envConfig from './config/env.js';
import { createLogger  } from './utils/logger.js';
import { appendResearchBadge, buildResearchBadgeText  } from './utils/footer.js';

import { cleanAssistantResponse } from './utils/text.js';
import { generatePromptCacheKey  } from './utils/promptCacheKey.js';
import { enableReleaseNotify  } from './tools/releaseNotify.js';
import { sendWhatsAppDirect  } from './tools/whatsappSender.js';
import {
  RELEASE_NOTIFY_ENABLED_PREFIX,
  RELEASE_NOTIFY_ALREADY_PREFIX,
  FALLBACK_ERROR_PREFIX
} from './config/systemMessages.js';
import { resolveProviderProfile } from './ai/providers/providerProfile.js';
import { providerFailureReply } from './ai/providers/errorPolicy.js';
import { notifyAdminDetailed, withAdminNotificationPolicy } from './utils/adminNotifier.js';
import { clearCallNotifications  } from './utils/notificationDedup.js';
import { wrapNewMessages, wrapSystemReminder  } from './utils/systemTags.js';
import { drainLiveMessages, renderLiveMessages } from './utils/liveInbox.js';
import { systemReply, textReply  } from './utils/replyEnvelope.js';

const log = createLogger('Handler');

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'input_text')?.text || '';
  return '';
}

/**
 * The first token of a message, lowercased, for slash-command matching.
 *
 * Platform content arrives labelled as `[DATE, TIME] UserName: /command …`, so
 * the token is taken after the colon that closes the label — the one right
 * after "]", never a colon the body itself contains. Unlabelled content is
 * matched from its own start.
 *
 * @param {string|Array} content - ctx.content
 * @returns {string}
 */
function extractLeadingCommand(content) {
  const text = extractPlainTextContent(content).trim().toLowerCase();
  const bracketEndIdx = text.indexOf(']');
  const separatorColonIdx = bracketEndIdx !== -1 ? text.indexOf(':', bracketEndIdx) : -1;
  if (separatorColonIdx === -1) return text;
  return text.substring(separatorColonIdx + 1).trim().split(/\s+/)[0] || text;
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

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle?, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId?, systemMessage? }
 */
async function _handleMessage(ctx) {
  // One root deadline for the whole turn. The work phase ends early enough to
  // leave a bounded tool-free wrap-up slice under that same deadline.
  const turnBudgets = createTurnBudgets(
    constants.TURN_BUDGET_MS,
    constants.TURN_WRAP_UP_RESERVE_MS
  );
  ctx.turnBudget = turnBudgets.work;
  const responseCtx = {
    discordTitle: '',
    // Accumulated source counts from GemiX web search and provider-native X
    // search, used for the badge appended to the reply.
    researchStats: null
  };

  try {
    const ui = ctx.userIdentity;
    const isActiveMember = ui.isActiveMember;
    const userIsAdmin = Boolean(ui.isAdmin);

    // -- Maintenance gate --
    // Blocks every non-admin request with a fixed message. Admins always pass.
    // Nothing above is parsed on the normal path: the command and its delivery
    // target are only needed once the gate has actually closed.
    if (envConfig.MAINTENANCE_MODE && constants.MAINTENANCE_ADMIN_ONLY && !userIsAdmin) {
      const command = extractLeadingCommand(ctx.content);
      if (command === constants.MAINTENANCE_RELEASE_NOTIFY_COMMAND.toLowerCase()) {
        const target = getReleaseNotifyTarget(ctx, ui);
        const enableResult = enableReleaseNotify(target.chatId, target.waJid);
        const text = enableResult.alreadyEnabled
          ? buildMaintenanceReleaseAlreadyEnabledMessage()
          : buildMaintenanceReleaseEnabledMessage();
        if (ctx.platform === constants.PLATFORM_DISCORD && target.waJid) {
          try {
            await sendWhatsAppDirect(target.waJid, text);
          } catch (err) {
            log.warn(`maintenance release notify mirror to WhatsApp failed: ${err.message}`);
          }
        }
        return systemReply(text);
      }
      log.info(`   Maintenance mode: ignoring non-admin request from ${ui.taskFileId}`);
      return systemReply(constants.MAINTENANCE_USER_MESSAGE);
    }

    const prepared = await prepareTurn(ctx, ui);
    const { isDiscord, allowVoice, userCtx, workspaceId, input } = prepared;
    let { staticInstructions, toolsFp } = prepared;
    const cleanTextResponse = text => cleanAssistantResponse(text);

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

    /**
     * Per-round state: the caller's latest preferences, the tools this round
     * offers, a static prefix realigned whenever that set changed, and the
     * reply schema. Shared by the agent loop and the forced wrap-up so the two
     * can never prepare a call differently.
     */
    const prepareRound = () => {
      // Picks up a manage_preferences change for this call's reasoning effort.
      reloadSettings(ctx, ui);

      const roundTools = getToolsForUser({
        ...userCtx,
        isActiveMember,
        isAdmin: userIsAdmin
      });
      const nextFp = toolsFingerprint(roundTools);
      if (nextFp !== toolsFp) {
        // Keep the cached system prefix aligned with the tool set actually
        // offered in this round.
        staticInstructions = buildStaticInstructions(ctx, roundTools);
        toolsFp = nextFp;
        syncStaticPrefix();
        log.info('   Static system prefix rebuilt (tool fingerprint changed mid-turn)');
      }

      // Discord keeps conversation_title in the strict schema on every turn.
      // An empty value preserves the title and keeps the cached prefix stable.
      const responseFormat = buildGemixResponseFormat({
        includeTitle: isDiscord,
        allowVoice
      });
      return { roundTools, responseFormat };
    };

    // One outbound message per destination per turn (per-round tool caps are
    // enforced upstream by perRoundCappedDuplicateIds).
    const deliveryCtx = {
      contactedWA: new Set(),
      contactedEmail: new Set()
    };

    /**
     * Hand the model whatever reached this chat since the last round.
     *
     * A message that arrives while a turn is running does not start a second
     * one (see utils/batchIngress.js); it is held per chat and shown here, so a
     * long turn can still take in the correction the user forgot or someone
     * else's reply instead of finishing on a request that has moved on. It is a
     * note, not the request: the same message returns as an ordinary user turn
     * in the next turn's history, which is why it is shown exactly once.
     */
    const showNewMessages = () => {
      const drained = drainLiveMessages(ctx?.liveInboxKey);
      const lines = renderLiveMessages(drained);
      if (lines.length === 0) return;
      input.push(userItem(wrapNewMessages(lines)));
      log.info(`   ${drained.messages.length + drained.overflow} message(s) arrived mid-turn`);
    };

    let rounds = 0;
    // A completed response can occasionally contain reasoning but no message
    // or tool call. One extra attempt only, never the whole round budget.
    let emptyOutputRetries = 0;
    const MAX_EMPTY_OUTPUT_RETRIES = 1;
    let lastModelUsed = null;
    let workBudgetLimitReached = false;
    const promptCacheKey = generatePromptCacheKey(userCtx);

    while (rounds < constants.MAX_TOOL_ROUNDS) {
      rounds++;

      if (turnBudgets.work.expired) {
        log.warn('   Turn work budget reached, forcing wrap up inside the reserved slice');
        workBudgetLimitReached = true;
        break;
      }

      const pLabel = (typeof ctx?.platform === 'string' && ctx.platform) ? ctx.platform.toUpperCase() : 'UNKNOWN';
      log.info(`[${pLabel}] AI call (round ${rounds}/${constants.MAX_TOOL_ROUNDS})`);

      showNewMessages();

      const { roundTools, responseFormat } = prepareRound();
      const callOpts = {
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort,
        budget: turnBudgetFrom(ctx),
        round: rounds,
        phase: 'work'
      };

      let roundResult;
      try {
        roundResult = await callAI(input, roundTools, callOpts);
      } catch (roundErr) {
        if (turnBudgets.work.expired) {
          log.warn('   AI round reached the turn work deadline; continuing to forced wrap-up');
          workBudgetLimitReached = true;
          break;
        }
        throw roundErr;
      }
      const { reply, provider, model, searchStats } = roundResult;
      lastModelUsed = model;
      accumulateSearchStats(responseCtx, searchStats);
      log.info(`   Provider: ${provider} (${model})`);

      if (reply.toolCalls.length > 0) {
        log.info(`[${pLabel}] ${reply.toolCalls.length} tool call(s)`);
        // The model's own output goes back verbatim — reasoning, message and
        // function_call items in the order it produced them. Replaying the
        // encrypted reasoning is what keeps the next round's thinking continuous.
        input.push(...reply.items);

        input.push(...await executeToolRound(reply.toolCalls, {
          userCtx,
          responseCtx,
          deliveryCtx,
          roundTools,
          platformCtx: ctx
        }));

        // A file or image preview a tool attached is worth its tokens on the
        // round it arrives and not after; the envelope stays either way.
        pruneSeenToolMedia(input);

        continue;
      }

      // The fixed structured reply carries the user-facing text in `response`,
      // plus nullable attachments, the Discord title, and (WhatsApp) the voice flag.
      const parsed = parseStructuredReply(reply.text || '');
      if (!parsed.structured) {
        log.warn('   Structured reply expected but content was not valid JSON; using raw text');
      }
      applyParsedTitle(parsed, responseCtx);
      const finalAttachments = resolveFinalAttachments(parsed, workspaceId);

      // Voice reply (WhatsApp dedicated only): speak `response` instead of
      // sending text. Falls back to text on limit/length/TTS failure.
      if (allowVoice && parsed.voice) {
        const voiceReply = await buildVoiceReply({
          rawResponseText: parsed.text,
          finalAttachments,
          budget: turnBudgets.work,
          ctx,
          responseCtx,
          modelUsed: lastModelUsed
        });
        if (voiceReply) return voiceReply;
        log.info('   Voice reply not produced; falling back to text');
      }

      let text = cleanTextResponse(parsed.text || '');
      log.info(`   [${pLabel}] Response generated (${text.length} chars, ${finalAttachments.length} attachment(s))`);

      // A Responses endpoint can return status=completed with only a reasoning
      // item (no function_call, no message/output_text). At most one retry; if it
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
            + 'Immediately call any tools you need (e.g. search_image for web photos) '
            + 'or send a valid structured reply. Never leave the reply empty.'
          )));
          continue;
        }
        log.warn(
          emptyOutputRetries > 0
            ? '   Empty AI response after retry, sending fallback'
            : '   Empty AI response, sending fallback'
        );
        return systemReply(FALLBACK_ERROR_PREFIX, {
          discordTitle: responseCtx.discordTitle || '',
          modelUsed: lastModelUsed
        });
      }

      // ── Research badge ──────────────────────────────────────────────────
      // Append "🌐: N sources. 𝕏: N searches." from the counts collected by
      // GemiX web search and provider-native X search. Zero sections stay out
      // so the badge remains minimal.
      if (text.trim() && responseCtx.researchStats) {
        const badge = buildResearchBadgeText(responseCtx.researchStats);
        if (badge) {
          text = appendResearchBadge(text, responseCtx.researchStats);
          log.info(`   Research badge: ${badge}`);
        }
      }

      return textReply({
        text: text || null,
        attachments: finalAttachments,
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed
      });
    }

    // ── Forced text wrap-up (work deadline or tool-round budget) ────────
    const wrapUpReason = workBudgetLimitReached
      ? 'turn work deadline'
      : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`;
    log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);
    let wrapUpText = '';
    let wrapUpAttachments = [];
    let wrapUpVoice = false;
    try {
      const { roundTools: wrapUpTools, responseFormat } = prepareRound();
      const wrapUpNote = workBudgetLimitReached
        ? 'This turn reached its work deadline. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      showNewMessages();
      input.push(userItem(wrapSystemReminder(wrapUpNote)));
      const { reply: finalReply, model: finalModel, searchStats } = await callAI(input, wrapUpTools, {
        toolChoice: 'none',
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort,
        budget: turnBudgets.root,
        round: rounds + 1,
        phase: 'wrap_up'
      });
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(responseCtx, searchStats);
      const parsed = parseStructuredReply(finalReply.text || '');
      applyParsedTitle(parsed, responseCtx);
      wrapUpAttachments = resolveFinalAttachments(parsed, workspaceId);
      wrapUpVoice = Boolean(allowVoice && parsed.voice);
      wrapUpText = wrapUpVoice ? (parsed.text || '') : cleanTextResponse(parsed.text || '');
    } catch (wrapErr) {
      log.error(`   Forced wrap-up call failed: ${wrapErr.message}`);
    }

    // Voice wrap-up reply (WhatsApp dedicated): speak it; fall back to text.
    if (wrapUpVoice && wrapUpText.trim()) {
      const voiceReply = await buildVoiceReply({
        rawResponseText: wrapUpText,
        finalAttachments: wrapUpAttachments,
        budget: turnBudgets.root,
        ctx,
        responseCtx,
        modelUsed: lastModelUsed
      });
      if (voiceReply) return voiceReply;
      wrapUpText = cleanTextResponse(wrapUpText);
    }
    if (wrapUpText.trim() && responseCtx.researchStats) {
      wrapUpText = appendResearchBadge(wrapUpText, responseCtx.researchStats);
    }

    return textReply({
      text: wrapUpText.trim() ? wrapUpText : FALLBACK_ERROR_PREFIX,
      attachments: wrapUpAttachments,
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed,
      // An empty wrap-up means the fallback banner is going out instead.
      systemMessage: !wrapUpText.trim()
    });

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
        await notifyAdminDetailed('AI Provider', `${err.kind}: ${err.message}`).catch(() => {});
      }
      return systemReply(providerReply.text, {
        discordTitle: responseCtx.discordTitle || ''
      });
    }

    log.error(`\n❌ [${platformLabel}] HANDLER ERROR:`);
    log.error(`   ${err.message}`);
    log.error(`   Stack: ${err.stack?.split('\n')[1]?.trim() || 'N/A'}`);
    await notifyAdminDetailed(
      'Message Handler',
      `${err.message}\n${err.stack || ''}`
    ).catch(() => {});

    return systemReply(FALLBACK_ERROR_PREFIX, {
      discordTitle: responseCtx.discordTitle || ''
    });
  } finally {
    // Drop the per-call notification dedup entries, so the next turn on this
    // chat can fire its own intermediate notifications, and release both
    // budgets' timers however the turn ended.
    try { clearCallNotifications(ctx); } catch { /* best effort */ }
    turnBudgets.work.dispose();
    turnBudgets.root.dispose();
  }
}

function handleMessage(ctx) {
  const adminIsCaller = Boolean(ctx?.userIdentity?.isAdmin);
  const conversationKey = generatePromptCacheKey(ctx);
  return withApiLogConversation(conversationKey, () => withAdminNotificationPolicy({
    suppress: adminIsCaller,
    reason: adminIsCaller ? 'The administrator is the current caller.' : ''
  }, () => _handleMessage(ctx)));
}

export { handleMessage };
