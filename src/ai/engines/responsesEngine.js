// src/ai/engines/responsesEngine.js
//
// The turn engine of the Responses runtime, where GemiX owns the loop. Each
// round is one callAI over the conversation items; the round's tool calls run
// through the round controller and come back as items, until the model answers
// or a limit forces one last tool-free call.

import { callAI } from '../aiProvider.js';
import { pruneSeenToolMedia, systemItem, userItem } from '../responsesItems.js';
import { buildStaticInstructions, toolsFingerprint } from '../systemPrompt.js';
import { executeToolRound } from '../toolRoundController.js';
import { accumulateSearchStats, finalizeTurnReply } from '../turnReply.js';
import { getToolsForUser } from '../tools.js';
import { buildGemixResponseFormat, parseStructuredReply } from '../responseSchema.js';
import { providerFailureReply } from '../providers/errorPolicy.js';
import { resolveProviderProfile } from '../providers/providerProfile.js';
import { WRAP_UP_REASON, takeNewMessagesNote, wrapUpNote } from './turnNotes.js';
import constants from '../../config/constants.js';
import { turnBudgetFrom } from '../../utils/turnBudget.js';
import { createLogger } from '../../utils/logger.js';
import { generatePromptCacheKey } from '../../utils/promptCacheKey.js';
import { wrapSystemReminder } from '../../utils/systemTags.js';

const log = createLogger('ResponsesEngine');
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

/** The model's final text as a parsed reply, saying so when it was not the structured one. */
function _parseFinalText(text) {
  const parsed = parseStructuredReply(text || '');
  if (!parsed.structured) {
    log.warn('   Structured reply expected but content was not valid JSON; using raw text');
  }
  return parsed;
}

/** Run the model/tool loop of one already-admitted turn on a Responses profile. */
async function runResponsesTurn({ ctx, prepared, turnBudgets, responseCtx }) {
  const { allowVoice, userCtx, workspaceId, input } = prepared;
  const turnSettings = ctx.settings ? { ...ctx.settings } : null;
  const prepareRound = _createRoundPreparation(ctx, prepared, input);
  const showNewMessages = () => {
    const note = takeNewMessagesNote(ctx);
    if (note) input.push(userItem(note));
  };
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

    const final = await finalizeTurnReply({
      parsed: _parseFinalText(reply.text),
      allowVoice,
      workspaceId,
      budget: turnBudgets.work,
      ctx,
      responseCtx,
      modelUsed: lastModelUsed
    });
    if (!final.empty) return final.reply;

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
    return final.reply;
  }

  const wrapUpReason = workBudgetLimitReached ? WRAP_UP_REASON.DEADLINE : WRAP_UP_REASON.ROUND_CAP;
  log.warn(`   Forcing final answer (${workBudgetLimitReached
    ? 'turn work deadline'
    : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`}, tool_choice:none)`);

  let parsed = null;
  try {
    const { roundTools, responseFormat } = prepareRound();
    showNewMessages();
    input.push(userItem(wrapUpNote(wrapUpReason)));
    const { reply, model, searchStats } = await callAI(input, roundTools, {
      toolChoice: 'none',
      requestId: ctx.requestId,
      responseFormat,
      promptCacheKey,
      reasoningEffort: turnSettings?.effort,
      budget: turnBudgets.root,
      round: rounds + 1,
      phase: 'wrap_up'
    });
    if (model) lastModelUsed = model;
    accumulateSearchStats(responseCtx, searchStats);
    parsed = _parseFinalText(reply.text);
  } catch (wrapErr) {
    if (providerFailureReply(wrapErr, resolveProviderProfile())) throw wrapErr;
    log.error(`   Forced wrap-up call failed: ${wrapErr.message}`);
  }

  const final = await finalizeTurnReply({
    parsed,
    allowVoice,
    workspaceId,
    budget: turnBudgets.root,
    ctx,
    responseCtx,
    modelUsed: lastModelUsed
  });
  if (final.empty) log.warn('   Empty wrap-up reply, sending fallback');
  return final.reply;
}

export { runResponsesTurn };
