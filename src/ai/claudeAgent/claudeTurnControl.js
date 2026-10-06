// src/ai/claudeAgent/claudeTurnControl.js
//
// GemiX's round contract inside a Claude Agent query, where Claude Code owns
// the loop.
//
// A round is one batch of GemiX tool calls, and PostToolBatch closes it. That
// boundary is where the program speaks, as between two Responses rounds: the
// messages that reached the chat meanwhile, then, once the round cap or the
// work deadline is reached, the wrap-up note. After wrap-up every GemiX call
// is refused before it runs. A batch without GemiX calls (the structured reply
// alone) is not a round.
//
// Each call runs through the same executeToolCall as a Responses round,
// re-authorized against the tools the user holds when it runs. Per-round caps
// count calls as they arrive, as executeToolRound counts a batch, and
// read-only calls overlap at most TOOL_READ_CONCURRENCY at a time.

import constants from '../../config/constants.js';
import { executeToolCall } from '../toolRoundController.js';
import { WRAP_UP_REASON, takeNewMessagesNote, wrapUpNote, wrapUpRefusal } from '../engines/turnNotes.js';
import { GEMIX_TOOL_PREFIX } from './gemixMcpServer.js';
import { createSemaphore } from '../../utils/concurrency.js';
import { createLogger } from '../../utils/logger.js';
import {
  PARALLEL_READ_ONLY_TOOLS,
  PER_ROUND_TOOL_LIMITS,
  TOOL_READ_CONCURRENCY,
  perRoundCapErrorPayload
} from '../../utils/toolCallExecution.js';

const log = createLogger('ClaudeTurn');

/**
 * The tool runner and hooks of one Claude Agent turn.
 *
 * @param {object} opts
 * @param {{ userCtx: object, responseCtx: object, deliveryCtx: object,
 *   platformCtx: object }} opts.state - executeToolCall's state, without the tools
 * @param {() => object[]} opts.liveTools - the tools the user holds right now
 * @param {import('../../utils/turnBudget.js').TurnBudget} opts.workBudget
 * @param {AbortSignal} opts.signal - ends a wait for a read slot
 * @param {Function} [opts.executeTool] - tools/index.js executeTool, replaceable in tests
 * @returns {{ runCall: Function, hooks: object, readonly rounds: number,
 *   readonly wrapUpReason: string|null }}
 */
function createClaudeTurnControl({ state, liveTools, workBudget, signal, executeTool }) {
  const capCounts = new Map();
  const readSlots = createSemaphore(TOOL_READ_CONCURRENCY);
  let rounds = 0;
  let wrapUpReason = null;

  async function runCall(tc) {
    const cap = PER_ROUND_TOOL_LIMITS[tc.name];
    if (Number.isFinite(cap) && cap >= 1) {
      const count = (capCounts.get(tc.name) || 0) + 1;
      capCounts.set(tc.name, count);
      if (count > cap) {
        log.warn(`Tool "${tc.name}" blocked: per-round cap (${cap}) exceeded`);
        return perRoundCapErrorPayload(tc.name, cap);
      }
    }
    const callState = { ...state, roundTools: liveTools() };
    if (!PARALLEL_READ_ONLY_TOOLS.has(tc.name)) return executeToolCall(tc, callState, executeTool);
    const release = await readSlots.acquire(signal);
    try {
      return await executeToolCall(tc, callState, executeTool);
    } finally {
      release();
    }
  }

  async function onToolBatch(input) {
    capCounts.clear();
    const calls = (input.tool_calls || []).filter(call => call.tool_name?.startsWith(GEMIX_TOOL_PREFIX));
    if (calls.length === 0) return {};
    rounds += 1;
    log.info(`   Tool round ${rounds}/${constants.MAX_TOOL_ROUNDS}: ${calls.length} call(s)`);

    const notes = [];
    const newMessages = takeNewMessagesNote(state.platformCtx);
    if (newMessages) notes.push(newMessages);
    if (!wrapUpReason) {
      if (rounds >= constants.MAX_TOOL_ROUNDS) wrapUpReason = WRAP_UP_REASON.ROUND_CAP;
      else if (workBudget.expired) wrapUpReason = WRAP_UP_REASON.DEADLINE;
      if (wrapUpReason) {
        log.warn(`   Forcing final answer (${wrapUpReason === WRAP_UP_REASON.DEADLINE
          ? 'turn work deadline'
          : `tool-round budget (${constants.MAX_TOOL_ROUNDS})`})`);
        notes.push(wrapUpNote(wrapUpReason));
      }
    }
    if (notes.length === 0) return {};
    return { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: notes.join('\n') } };
  }

  async function beforeToolUse(input) {
    if (!wrapUpReason || !input.tool_name?.startsWith(GEMIX_TOOL_PREFIX)) return {};
    log.warn(`   Tool "${input.tool_name}" refused after wrap-up`);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: wrapUpRefusal(wrapUpReason)
      }
    };
  }

  return {
    runCall,
    hooks: {
      PostToolBatch: [{ hooks: [onToolBatch] }],
      PreToolUse: [{ hooks: [beforeToolUse] }]
    },
    get rounds() { return rounds; },
    get wrapUpReason() { return wrapUpReason; }
  };
}

export { createClaudeTurnControl };
