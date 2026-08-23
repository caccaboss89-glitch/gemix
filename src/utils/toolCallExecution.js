// src/utils/toolCallExecution.js
//
// Shared helpers for ordering and batching tool calls within one model turn.

const HANDLER_DELIVERY_TOOLS = new Set(['send_email', 'send_whatsapp_message']);

/**
 * @param {object[]} toolCalls - assistant tool_calls in model order
 * @returns {{ phase1: object[], phase2: object[] }}
 *   phase1: standard tools (parallel) — build, generate_*, …
 *   phase2: outbound delivery (parallel) — send_email, send_whatsapp_message
 */
function partitionHandlerToolCalls(toolCalls) {
  const phase1 = [];
  const phase2 = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (HANDLER_DELIVERY_TOOLS.has(name)) {
      phase2.push(tc);
    } else {
      phase1.push(tc);
    }
  }
  return { phase1, phase2 };
}

/**
 * Per-round caps for main-brain tools (handler + tools/index.js).
 *
 * Only tools where repeating the call in the same round is pointless or unsafe
 * are listed. Generation tools (generate_image / generate_video / generate_music)
 * are intentionally NOT capped here: their real constraint is the per-user
 * weekly quota (mediaUsageLimits.js), so capping them per round would only
 * waste model rounds.
 *
 * The first `limit` calls run and the extra ones get an error, so a repeated
 * read costs the model an error line rather than a whole round.
 *
 * The workspace tools are deliberately absent: an agentic round routinely
 * reads several files or runs several commands, and mutations already
 * serialize on the per-workspace lock rather than racing.
 */
const PER_ROUND_TOOL_LIMITS = {
  read_music_stats: 1,
  // A video costs ~1 frame per second of context; loading several at once is
  // the flood read_video exists to prevent.
  read_video: 1
};

const ONCE_PER_ROUND_ERROR =
  'can only be called once per round. Use the result from the previous call in this round.';

/**
 * Given tool calls in model order, return ids that exceed per-round caps.
 * Counts are per model turn (same batch), in call order — first N run, rest
 * block.
 *
 * @param {object[]} toolCalls
 * @param {Record<string, number>} [limits] - defaults to PER_ROUND_TOOL_LIMITS
 * @returns {Set<string>} tool_call ids to block
 */
function perRoundCappedDuplicateIds(toolCalls, limits = PER_ROUND_TOOL_LIMITS) {
  const blocked = new Set();
  if (!Array.isArray(toolCalls)) return blocked;

  const byName = new Map();
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    const max = limits[name];
    if (!name || !Number.isFinite(max) || max < 1) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(tc);
  }

  for (const [name, calls] of byName) {
    for (const tc of calls.slice(limits[name])) blocked.add(tc.id);
  }
  return blocked;
}

function oncePerRoundErrorPayload(toolName) {
  return JSON.stringify({
    success: false,
    error: `"${toolName}" ${ONCE_PER_ROUND_ERROR}`
  });
}

function perRoundCapErrorPayload(toolName, limit) {
  if (limit === 1) return oncePerRoundErrorPayload(toolName);
  return JSON.stringify({
    success: false,
    error: `"${toolName}" can only be called ${limit} time(s) per round. Use results from earlier calls in this round.`
  });
}

export {
  partitionHandlerToolCalls,
  PER_ROUND_TOOL_LIMITS,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload

};