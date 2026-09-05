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

import { withApiLogConversation } from './ai/apiLogs.js';
import { prepareTurn } from './ai/turnPreparation.js';
import { handleMaintenanceAdmission } from './ai/turnMaintenance.js';
import { runPreparedTurn } from './ai/turnOrchestrator.js';
import constants from './config/constants.js';
import { createTurnBudgets } from './utils/turnBudget.js';
import { createLogger  } from './utils/logger.js';
import { generatePromptCacheKey  } from './utils/promptCacheKey.js';
import { FALLBACK_ERROR_PREFIX } from './config/systemMessages.js';
import { resolveProviderProfile } from './ai/providers/providerProfile.js';
import { providerFailureReply } from './ai/providers/errorPolicy.js';
import { notifyAdminDetailed, withAdminNotificationPolicy } from './utils/adminNotifier.js';
import { clearCallNotifications  } from './utils/notificationDedup.js';
import { systemReply } from './utils/replyEnvelope.js';

const log = createLogger('Handler');

/**
 * Main message handler. Takes a normalized context and returns a response object.
 * @param {object} ctx
 * @param {object} [dependencies] Optional maintenance integration dependencies.
 * @returns {Promise<object>} Response { text, voiceBuffer, isVoiceOnly, attachments, modelUsed, discordTitle?, researchFooter?, voiceTranscriptText?, voiceTranscriptChatId?, systemMessage? }
 */
async function _handleMessage(ctx, dependencies = {}) {
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

    const maintenanceReply = await handleMaintenanceAdmission(ctx, ui, dependencies.maintenance);
    if (maintenanceReply) return maintenanceReply;

    const prepared = await prepareTurn(ctx, ui);
    return await runPreparedTurn({ ctx, prepared, turnBudgets, responseCtx });

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

function handleMessage(ctx, dependencies = {}) {
  const adminIsCaller = Boolean(ctx?.userIdentity?.isAdmin);
  const conversationKey = generatePromptCacheKey(ctx);
  return withApiLogConversation(conversationKey, () => withAdminNotificationPolicy({
    suppress: adminIsCaller,
    reason: adminIsCaller ? 'The administrator is the current caller.' : ''
  }, () => _handleMessage(ctx, dependencies)));
}

export { handleMessage };
