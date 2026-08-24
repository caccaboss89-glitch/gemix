// Execute one model tool-call batch while preserving call order in the
// Responses transcript. Standard calls may run in parallel; delivery calls
// remain serialized to protect per-destination semantics.

import { getToolAccessError } from './tools.js';
import { toolResultItems } from './responsesItems.js';
import { resolveProfile, toolUnavailableMessage } from '../config/platformCapabilities.js';
import { executeTool } from '../tools/index.js';
import {
  partitionHandlerToolCalls,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
  PER_ROUND_TOOL_LIMITS
} from '../utils/toolCallExecution.js';
import { createLogger } from '../utils/logger.js';
import { summarizeToolCall, summarizeToolResult } from '../utils/toolLogSummary.js';

const log = createLogger('ToolRound');

function _unavailableMessage(toolName, ctx) {
  return toolUnavailableMessage(toolName, resolveProfile(ctx), {
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember)
  });
}

async function _runToolCall(tc, state) {
  try {
    log.info('Executing:', summarizeToolCall(tc));
    const { toolCallId, result } = await executeTool(
      { id: tc.id, function: { name: tc.name, arguments: tc.arguments } },
      state.userCtx,
      state.responseCtx,
      state.deliveryCtx,
      state.roundTools
    );
    log.info('Result:', summarizeToolResult(result));
    return toolResultItems(toolCallId, result);
  } catch (err) {
    log.error(`Tool error "${tc.name}": ${err.message}`);
    return toolResultItems(tc.id, JSON.stringify({ success: false, error: `Execution error: ${err.message}` }));
  }
}

async function executeToolRound(toolCalls, state) {
  const allowedToolNames = new Set(state.roundTools.map(tool => tool.function?.name).filter(Boolean));
  const phases = partitionHandlerToolCalls(toolCalls);
  const resultsById = new Map();

  const runPhase = async (batch, parallel) => {
    const blocked = perRoundCappedDuplicateIds(batch, PER_ROUND_TOOL_LIMITS);
    const runOne = async (tc) => {
      if (blocked.has(tc.id)) {
        const cap = PER_ROUND_TOOL_LIMITS[tc.name];
        log.warn(`Tool "${tc.name}" blocked: per-round cap (${cap}) exceeded`);
        return toolResultItems(tc.id, perRoundCapErrorPayload(tc.name, cap));
      }
      const accessError = getToolAccessError(
        tc.name,
        allowedToolNames,
        name => _unavailableMessage(name, state.platformCtx)
      );
      if (accessError) {
        log.warn(`Tool "${tc.name}" blocked: ${accessError}`);
        return toolResultItems(tc.id, JSON.stringify({ success: false, error: accessError }));
      }
      return _runToolCall(tc, state);
    };

    if (parallel) {
      await Promise.all(batch.map(async tc => { resultsById.set(tc.id, await runOne(tc)); }));
    } else {
      for (const tc of batch) resultsById.set(tc.id, await runOne(tc));
    }
  };

  await runPhase(phases.standard, true);
  await runPhase(phases.delivery, false);
  return toolCalls.flatMap(tc => resultsById.get(tc.id) || []);
}

export { executeToolRound };
