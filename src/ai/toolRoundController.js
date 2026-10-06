// Execute one model tool-call batch while preserving its semantic order and
// its call order in the Responses transcript. Only consecutive read-only
// calls overlap; effects form ordering barriers and run serially.
//
// The single-call step, executeToolCall, is shared with the Claude Agent
// engine, whose runtime does the batching itself and hands GemiX one call at a
// time.

import { getToolAccessError } from './tools.js';
import { toolResultItems } from './responsesItems.js';
import { resolveProfile, toolUnavailableMessage } from '../config/platformCapabilities.js';
import { executeTool } from '../tools/index.js';
import {
  planHandlerToolCalls,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
  PER_ROUND_TOOL_LIMITS,
  TOOL_READ_CONCURRENCY
} from '../utils/toolCallExecution.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { createLogger } from '../utils/logger.js';
import { summarizeToolCall, summarizeToolResult } from '../utils/toolLogSummary.js';

const log = createLogger('ToolRound');

function _unavailableMessage(toolName, ctx) {
  return toolUnavailableMessage(toolName, resolveProfile(ctx), {
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember)
  });
}

function _failurePayload(error) {
  return JSON.stringify({ success: false, status: 'failed', error });
}

/**
 * Run one model tool call against the tools offered this round: access check,
 * execution and logging, with any failure turned into the standard failed
 * payload. Batching and per-round caps belong to the caller.
 *
 * @param {{ id: string, name: string, arguments: string }} tc
 * @param {{ userCtx: object, responseCtx: object, deliveryCtx: object,
 *   roundTools: object[], platformCtx: object }} state
 * @param {Function} [execute] - tools/index.js executeTool, replaceable in tests
 * @returns {Promise<string|Array|object>} the tool's result, in the shape
 *   toolResultItems takes
 */
async function executeToolCall(tc, state, execute = executeTool) {
  const accessError = getToolAccessError(
    tc.name,
    new Set(state.roundTools.map(tool => tool.function?.name).filter(Boolean)),
    name => _unavailableMessage(name, state.platformCtx)
  );
  if (accessError) {
    log.warn(`Tool "${tc.name}" blocked: ${accessError}`);
    return _failurePayload(accessError);
  }
  try {
    log.info('Executing:', summarizeToolCall(tc));
    const { result } = await execute(
      { id: tc.id, function: { name: tc.name, arguments: tc.arguments } },
      state.userCtx,
      state.responseCtx,
      state.deliveryCtx,
      state.roundTools
    );
    log.info('Result:', summarizeToolResult(result));
    return result;
  } catch (err) {
    log.error(`Tool error "${tc.name}": ${err.message}`);
    return _failurePayload(`Execution error: ${err.message}`);
  }
}

async function executeToolRound(toolCalls, state, dependencies = {}) {
  const phases = planHandlerToolCalls(toolCalls);
  // Caps belong to the complete model response, not to an execution phase. A
  // mutation between two capped reads must not reset their count.
  const blocked = perRoundCappedDuplicateIds(toolCalls, PER_ROUND_TOOL_LIMITS);
  const resultsByCall = new Map();
  const execute = dependencies.executeTool || executeTool;

  const runOne = async (tc) => {
    if (blocked.has(tc.id)) {
      const cap = PER_ROUND_TOOL_LIMITS[tc.name];
      log.warn(`Tool "${tc.name}" blocked: per-round cap (${cap}) exceeded`);
      return toolResultItems(tc.id, perRoundCapErrorPayload(tc.name, cap));
    }
    return toolResultItems(tc.id, await executeToolCall(tc, state, execute));
  };

  for (const phase of phases) {
    if (phase.mode === 'parallel-read') {
      const phaseResults = await mapWithConcurrency(phase.calls, TOOL_READ_CONCURRENCY, runOne);
      for (let i = 0; i < phase.calls.length; i++) {
        resultsByCall.set(phase.calls[i], phaseResults[i]);
      }
    } else {
      for (const tc of phase.calls) resultsByCall.set(tc, await runOne(tc));
    }
  }

  return toolCalls.flatMap(tc => resultsByCall.get(tc) || []);
}

export { executeToolCall, executeToolRound };
