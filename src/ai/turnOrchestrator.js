import { callAI } from './aiProvider.js';
import { pruneSeenToolMedia, systemItem, userItem } from './responsesItems.js';
import { buildStaticInstructions, toolsFingerprint } from './systemPrompt.js';
import { executeToolRound } from './toolRoundController.js';
import {
  accumulateSearchStats,
  applyParsedTitle,
  buildVoiceReply,
  resolveFinalAttachments
} from './turnReply.js';
import { getToolsForUser } from './tools.js';
import { buildGemixResponseFormat, parseStructuredReply } from './responseSchema.js';
import constants from '../config/constants.js';
import { FALLBACK_ERROR_PREFIX } from '../config/systemMessages.js';
import { turnBudgetFrom } from '../utils/turnBudget.js';
import { createLogger } from '../utils/logger.js';
import { appendResearchBadge, buildResearchBadgeText } from '../utils/footer.js';
import { cleanAssistantResponse } from '../utils/text.js';
import { generatePromptCacheKey } from '../utils/promptCacheKey.js';
import { providerFailureReply } from './providers/errorPolicy.js';
import { resolveProviderProfile } from './providers/providerProfile.js';
import { wrapNewMessages, wrapSystemReminder } from '../utils/systemTags.js';
import { drainLiveMessages, renderLiveMessages } from '../utils/liveInbox.js';
import { systemReply, textReply } from '../utils/replyEnvelope.js';

const log = createLogger('TurnOrchestrator');
const MAX_EMPTY_OUTPUT_RETRIES = 1;

/** Keep the cached static prefix aligned with the tools offered each round. */
function _createRoundPreparation(ctx, prepared, input) {
  const { isDiscord, allowVoice, userCtx } = prepared;
  let { staticInstructions, toolsFp } = prepared;

  const syncStaticPrefix = () => {
    if (input[0] && input[0]._staticPrefix) {
      input[0].content = [{ type: 'input_text', text: staticInstructions }];
    } else {
      const item = systemItem(staticInstructions);
      item._staticPrefix = true;
      input.unshift(item);
    }
  };

  return () => {
    const roundTools = getToolsForUser({
      ...userCtx,
      isActiveMember: ctx.userIdentity.isActiveMember,
      isAdmin: Boolean(ctx.userIdentity.isAdmin)
    });
    const nextFp = toolsFingerprint(roundTools);
    if (nextFp !== toolsFp) {
      staticInstructions = buildStaticInstructions(ctx, roundTools);
      toolsFp = nextFp;
      syncStaticPrefix();
      log.info('   Static system prefix rebuilt (tool fingerprint changed mid-turn)');
    }

    return {
      roundTools,
      responseFormat: buildGemixResponseFormat({ includeTitle: isDiscord, allowVoice })
    };
  };
}

/** Add messages that arrived after the preceding model round. */
function _createLiveMessageDrain(ctx, input) {
  return () => {
    const drained = drainLiveMessages(ctx?.liveInboxKey);
    const lines = renderLiveMessages(drained);
    if (lines.length === 0) return;
    input.push(userItem(wrapNewMessages(lines)));
    log.info(`   ${drained.messages.length + drained.overflow} message(s) arrived mid-turn`);
  };
}

function _appendResearchBadge(text, responseCtx) {
  if (!text.trim() || !responseCtx.researchStats) return text;
  const badge = buildResearchBadgeText(responseCtx.researchStats);
  if (!badge) return text;
  log.info(`   Research badge: ${badge}`);
  return appendResearchBadge(text, responseCtx.researchStats);
}

async function _buildFinalReply({
  parsed,
  allowVoice,
  workspaceId,
  turnBudgets,
  ctx,
  responseCtx,
  modelUsed
}) {
  applyParsedTitle(parsed, responseCtx);
  const attachments = resolveFinalAttachments(parsed, workspaceId);
  if (allowVoice && parsed.voice) {
    const voiceReply = await buildVoiceReply({
      rawResponseText: parsed.text,
      finalAttachments: attachments,
      budget: turnBudgets.work,
      ctx,
      responseCtx,
      modelUsed
    });
    if (voiceReply) return { reply: voiceReply, attachments };
    log.info('   Voice reply not produced; falling back to text');
  }
  return { reply: null, attachments };
}

/** Run the model/tool state machine for one already-admitted turn. */
async function runPreparedTurn({ ctx, prepared, turnBudgets, responseCtx }) {
  const { allowVoice, userCtx, workspaceId, input } = prepared;
  const turnSettings = ctx.settings ? { ...ctx.settings } : null;
  const prepareRound = _createRoundPreparation(ctx, prepared, input);
  const showNewMessages = _createLiveMessageDrain(ctx, input);
  const deliveryCtx = { contactedWA: new Set(), contactedEmail: new Set() };
  const promptCacheKey = generatePromptCacheKey(userCtx);
  const platformLabel = typeof ctx?.platform === 'string' && ctx.platform
    ? ctx.platform.toUpperCase()
    : 'UNKNOWN';

  let rounds = 0;
  let emptyOutputRetries = 0;
  let lastModelUsed = null;
  let workBudgetLimitReached = false;

  while (rounds < constants.MAX_TOOL_ROUNDS) {
    rounds++;
    if (turnBudgets.work.expired) {
      log.warn('   Turn work budget reached, forcing wrap up inside the reserved slice');
      workBudgetLimitReached = true;
      break;
    }

    log.info(`[${platformLabel}] AI call (round ${rounds}/${constants.MAX_TOOL_ROUNDS})`);
    showNewMessages();
    const { roundTools, responseFormat } = prepareRound();

    let roundResult;
    try {
      roundResult = await callAI(input, roundTools, {
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: ctx.requestId,
        responseFormat,
        promptCacheKey,
        reasoningEffort: turnSettings?.effort,
        budget: turnBudgetFrom(ctx),
        round: rounds,
        phase: 'work'
      });
    } catch (roundErr) {
      // Credential and allowance failures must reach the shared provider
      // renderer even when they arrive at the work deadline.
      if (providerFailureReply(roundErr, resolveProviderProfile())) throw roundErr;
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
      log.info(`[${platformLabel}] ${reply.toolCalls.length} tool call(s)`);
      input.push(...reply.items);
      input.push(...await executeToolRound(reply.toolCalls, {
        userCtx,
        responseCtx,
        deliveryCtx,
        roundTools,
        platformCtx: ctx
      }));
      pruneSeenToolMedia(input);
      continue;
    }

    const parsed = parseStructuredReply(reply.text || '');
    if (!parsed.structured) {
      log.warn('   Structured reply expected but content was not valid JSON; using raw text');
    }
    const final = await _buildFinalReply({
      parsed,
      allowVoice,
      workspaceId,
      turnBudgets,
      ctx,
      responseCtx,
      modelUsed: lastModelUsed
    });
    if (final.reply) return final.reply;

    let text = cleanAssistantResponse(parsed.text || '');
    log.info(
      `   [${platformLabel}] Response generated (${text.length} chars, ${final.attachments.length} attachment(s))`
    );

    if (!text.trim() && final.attachments.length === 0) {
      if (emptyOutputRetries < MAX_EMPTY_OUTPUT_RETRIES && rounds < constants.MAX_TOOL_ROUNDS) {
        emptyOutputRetries += 1;
        log.warn(`   Empty model output — one retry (${emptyOutputRetries}/${MAX_EMPTY_OUTPUT_RETRIES})`);
        if (reply.items.length > 0) input.push(...reply.items);
        input.push(userItem(wrapSystemReminder(
          'Your previous output was empty: no tool call and no structured reply. '
          + 'Immediately call any tools you need (e.g. search_image for web photos) '
          + 'or send a valid structured reply. Never leave the reply empty.'
        )));
        continue;
      }
      log.warn(emptyOutputRetries > 0
        ? '   Empty AI response after retry, sending fallback'
        : '   Empty AI response, sending fallback');
      return systemReply(FALLBACK_ERROR_PREFIX, {
        discordTitle: responseCtx.discordTitle || '',
        modelUsed: lastModelUsed
      });
    }

    text = _appendResearchBadge(text, responseCtx);
    return textReply({
      text: text || null,
      attachments: final.attachments,
      discordTitle: responseCtx.discordTitle || '',
      modelUsed: lastModelUsed
    });
  }

  const wrapUpReason = workBudgetLimitReached
    ? 'turn work deadline'
    : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`;
  log.warn(`   Forcing final answer (${wrapUpReason}, tool_choice:none)`);

  let wrapUpText = '';
  let wrapUpAttachments = [];
  let wrapUpVoice = false;
  try {
    const { roundTools, responseFormat } = prepareRound();
    const wrapUpNote = workBudgetLimitReached
      ? 'This turn reached its work deadline. You cannot run more tools. Reply now with what you have so far; say clearly if something is unfinished. Never mention tools, time limits, or this note.'
      : 'You can no longer run tools for this turn. Reply now: answer the user with everything you gathered, and if the task is not fully complete tell them what is done and that you had to stop here. Never mention tools, rounds, or this note.';
    showNewMessages();
    input.push(userItem(wrapSystemReminder(wrapUpNote)));
    const { reply: finalReply, model: finalModel, searchStats } = await callAI(input, roundTools, {
      toolChoice: 'none',
      requestId: ctx.requestId,
      responseFormat,
      promptCacheKey,
      reasoningEffort: turnSettings?.effort,
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
    wrapUpText = wrapUpVoice ? (parsed.text || '') : cleanAssistantResponse(parsed.text || '');
  } catch (wrapErr) {
    if (providerFailureReply(wrapErr, resolveProviderProfile())) throw wrapErr;
    log.error(`   Forced wrap-up call failed: ${wrapErr.message}`);
  }

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
  wrapUpText = _appendResearchBadge(wrapUpText, responseCtx);

  return textReply({
    text: wrapUpText.trim() ? wrapUpText : FALLBACK_ERROR_PREFIX,
    attachments: wrapUpAttachments,
    discordTitle: responseCtx.discordTitle || '',
    modelUsed: lastModelUsed,
    systemMessage: !wrapUpText.trim()
  });
}

export { runPreparedTurn };
