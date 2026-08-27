// src/utils/toolCallExecution.js
//
// Shared helpers for ordering and batching tool calls within one model turn.
//
// A tool call here is the Responses shape the transport reads off a
// `function_call` item: `{ id, name, arguments }`.

// Only calls that observe state without changing it may share a phase. Unknown
// and future tools default to serial execution: adding a new executor must not
// silently make its effects race with the calls around it.
const PARALLEL_READ_ONLY_TOOLS = new Set([
  'search_web',
  'read_page',
  'search_image',
  'list_files',
  'search_files',
  'read_file',
  'read_my_tasks',
  'read_music_stats'
]);
// read_sent_messages is deliberately serial: recovering an audited attachment
// downloads and projects a new file into this conversation's attachments/.

/** Maximum simultaneous read-only calls within one consecutive phase. */
const TOOL_READ_CONCURRENCY = 4;

/**
 * @param {object[]} toolCalls - `{id, name, arguments}` in model order
 * Split calls into consecutive execution phases without changing model order.
 * Adjacent read-only calls form one bounded-parallel phase; every other call
 * forms part of a serial phase. A read after an effect therefore cannot start
 * before that effect has completed.
 *
 * @returns {{ mode: 'parallel-read'|'serial', calls: object[] }[]}
 */
function planHandlerToolCalls(toolCalls) {
  const phases = [];
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    const mode = PARALLEL_READ_ONLY_TOOLS.has(tc.name) ? 'parallel-read' : 'serial';
    const previous = phases.at(-1);
    if (previous?.mode === mode) previous.calls.push(tc);
    else phases.push({ mode, calls: [tc] });
  }
  return phases;
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
  read_music_stats: 1
};

const ONCE_PER_ROUND_ERROR =
  'can only be called once per round. Use the result from the previous call in this round.';

/**
 * Given tool calls in model order, return ids that exceed per-round caps.
 * Counts are per model turn (same batch), in call order — first N run, rest
 * block.
 *
 * @param {object[]} toolCalls - `{id, name, arguments}` in model order
 * @param {Record<string, number>} [limits] - defaults to PER_ROUND_TOOL_LIMITS
 * @returns {Set<string>} call ids to block
 */
function perRoundCappedDuplicateIds(toolCalls, limits = PER_ROUND_TOOL_LIMITS) {
  const blocked = new Set();
  if (!Array.isArray(toolCalls)) return blocked;

  const byName = new Map();
  for (const tc of toolCalls) {
    const name = tc.name;
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
    status: 'failed',
    error: `"${toolName}" ${ONCE_PER_ROUND_ERROR}`
  });
}

function perRoundCapErrorPayload(toolName, limit) {
  if (limit === 1) return oncePerRoundErrorPayload(toolName);
  return JSON.stringify({
    success: false,
    status: 'failed',
    error: `"${toolName}" can only be called ${limit} time(s) per round. Use results from earlier calls in this round.`
  });
}

export {
  PARALLEL_READ_ONLY_TOOLS,
  TOOL_READ_CONCURRENCY,
  planHandlerToolCalls,
  PER_ROUND_TOOL_LIMITS,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload
};
