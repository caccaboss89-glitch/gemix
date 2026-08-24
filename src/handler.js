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
//      (1) standard tools parallel, (2) delivery calls serial - repeat until the
//      model returns the final response or the round budget is reached. The
//      final reply is always structured JSON (response / nullable attachments,
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
  userItem
} from './ai/responsesItems.js';
import {
  buildStaticInstructions,
  promptToolsFingerprint
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

import { cleanAssistantResponse, renderInlineCitations  } from './utils/text.js';
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
import { notifyAdmin } from './utils/adminNotifier.js';
import { clearCallNotifications  } from './utils/notificationDedup.js';
import { wrapSystemReminder  } from './utils/systemTags.js';

const log = createLogger('Handler');

function extractPlainTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(p => p.type === 'input_text')?.text || '';
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
async function handleMessage(ctx) {
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

    const prepared = await prepareTurn(ctx, ui);
    const { isDiscord, allowVoice, userCtx, workspaceId, input } = prepared;
    let { staticInstructions, toolsFp } = prepared;

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

      // Pick up a manage_preferences change for this call's reasoning effort.
      // Static prefix stays byte-identical unless the tool fingerprint changes.
      reloadSettings(ctx, ui);

      const roundTools = getToolsForUser({
        ...userCtx,
        isActiveMember,
        isAdmin: userIsAdmin
      });
      const nextFp = promptToolsFingerprint(ctx);
      if (nextFp !== toolsFp) {
        // Keep the cached system prefix aligned with the tool set actually
        // offered in this round.
        staticInstructions = buildStaticInstructions(ctx);
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
      const callOpts = {
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort,
        budget: turnBudgetFrom(ctx)
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
      const finalAttachments = await resolveFinalAttachments(parsed, workspaceId, turnBudgets.work.signal);

      // Voice reply (WhatsApp dedicated only): speak `response` (with TTS tags)
      // instead of sending text. Falls back to text on limit/length/TTS failure.
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
      // Append "🌐: N sources. 𝕏: N posts." from the counts collected by
      // GemiX web search and provider-native X search. Zero sections stay out
      // so the badge remains minimal.
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

    // ── Forced text wrap-up (work deadline or tool-round budget) ────────
    const wrapUpReason = workBudgetLimitReached
      ? 'turn work deadline'
      : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`;
    log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);
    let wrapUpText = '';
    let wrapUpAttachments = [];
    let wrapUpVoice = false;
    try {
      reloadSettings(ctx, ui);
      const wrapUpTools = getToolsForUser({
        ...userCtx,
        isActiveMember,
        isAdmin: userIsAdmin
      });
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
      const wrapUpNote = workBudgetLimitReached
        ? 'This turn reached its work deadline. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
        : 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
      input.push(userItem(wrapSystemReminder(wrapUpNote)));
      const { reply: finalReply, model: finalModel, searchStats } = await callAI(input, wrapUpTools, {
        toolChoice: 'none',
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: ctx.settings?.effort,
        budget: turnBudgets.root
      });
      if (finalModel) lastModelUsed = finalModel;
      accumulateSearchStats(responseCtx, searchStats);
      const parsed = parseStructuredReply(finalReply.text || '');
      applyParsedTitle(parsed, responseCtx);
      wrapUpAttachments = await resolveFinalAttachments(parsed, workspaceId, turnBudgets.root.signal);
      wrapUpVoice = Boolean(allowVoice && parsed.voice);
      wrapUpText = wrapUpVoice ? (parsed.text || '') : cleanAssistantResponse(parsed.text || '');
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
    // Durable history expires on the shared 4h sweep. The read-only attachment
    // projection was already reconciled with this turn's visible context; its
    // removal never deletes the durable raw used for later rehydration.
    //
    // Drop per-call notification dedup entries so subsequent AI calls can
    // fire intermediate notifications.
    try { clearCallNotifications(ctx); } catch { /* best effort */ }
    turnBudgets.work.dispose();
    turnBudgets.root.dispose();
  }
}

export { handleMessage
};
