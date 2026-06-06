// src/utils/toolCallExecution.js
//
// Shared helpers for ordering and batching tool calls within one model turn.

const { resolveActiveMemberByName } = require('../config/members');
const {
  MAX_GENERATE_IMAGE_PER_ROUND,
  MAX_GENERATE_VIDEO_PER_ROUND,
} = require('../config/constants');
const { normalizePhoneToJid } = require('../tools/whatsappSender');

function parseToolCallArgs(tc) {
  const raw = JSON.parse(tc.function.arguments || '{}');
  const args = {};
  for (const key of Object.keys(raw)) {
    args[key.trim()] = raw[key];
  }
  return args;
}

/**
 * Voice message to the current chat ends the turn; it must run after all other
 * tools in the same round so preceding tools still execute.
 */
function isSendVoiceMessageToCurrentUser(tc, userCtx) {
  if (!tc?.function || tc.function.name !== 'send_voice_message') return false;
  let args;
  try {
    args = parseToolCallArgs(tc);
  } catch {
    return false;
  }

  const recipientName = args.recipient?.name || args.recipientName;
  const recipientPhone = args.recipient?.phone || args.recipientPhone;
  if (!recipientName && !recipientPhone) return true;

  if (recipientName) {
    const resolved = resolveActiveMemberByName(recipientName);
    if (resolved.ok && resolved.member.wa === userCtx.waJid) return true;
  }
  if (recipientPhone && userCtx.waJid) {
    const normalized = normalizePhoneToJid(recipientPhone);
    if (normalized === userCtx.waJid) return true;
  }
  return false;
}

const HANDLER_DELIVERY_TOOLS = new Set(['send_email', 'send_whatsapp_message']);

/**
 * @param {object[]} toolCalls - assistant tool_calls in model order
 * @param {object} userCtx
 * @returns {{ phase1: object[], phase2: object[], phase3: object[] }}
 *   phase1: standard tools (parallel) — build, generate_*, read_file, web_x_search, …
 *   phase2: outbound delivery (parallel) — send_email, send_whatsapp, voice to others
 *   phase3: send_voice_message to current chat only (sequential; can end the turn)
 */
function partitionHandlerToolCalls(toolCalls, userCtx) {
  const phase1 = [];
  const phase2 = [];
  const phase3 = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (isSendVoiceMessageToCurrentUser(tc, userCtx)) {
      phase3.push(tc);
    } else if (
      HANDLER_DELIVERY_TOOLS.has(name)
      || (name === 'send_voice_message')
    ) {
      phase2.push(tc);
    } else {
      phase1.push(tc);
    }
  }
  return { phase1, phase2, phase3 };
}

const BUILD_MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

/** Tools limited to one invocation per model turn (main brain + build sub-agent). */
const ONCE_PER_ROUND_TOOL_NAMES = new Set(['web_x_search']);

/** Per-round caps for main-brain tools (handler + tools/index.js). */
const PER_ROUND_TOOL_LIMITS = {
  read_music_stats: 1,
  read_server_rules: 1,
  web_x_search: 1,
  build: 1,
  generate_image: MAX_GENERATE_IMAGE_PER_ROUND,
  generate_video: MAX_GENERATE_VIDEO_PER_ROUND,
};

const ONCE_PER_ROUND_ERROR =
  'can only be called once per round. Use the result from the previous call in this round.';

/**
 * Given tool calls in model order, return ids of duplicate once-per-round tools.
 * Does not mutate any context — caller should reject these before execution.
 *
 * @param {object[]} toolCalls
 * @param {Set<string>} [toolNames] - defaults to ONCE_PER_ROUND_TOOL_NAMES
 * @returns {Set<string>} tool_call ids to block
 */
function oncePerRoundDuplicateIds(toolCalls, toolNames = ONCE_PER_ROUND_TOOL_NAMES) {
  const blocked = new Set();
  const seen = new Set();
  if (!Array.isArray(toolCalls)) return blocked;
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name || !toolNames.has(name)) continue;
    if (seen.has(name)) blocked.add(tc.id);
    else seen.add(name);
  }
  return blocked;
}

/**
 * Given tool calls in model order, return ids that exceed per-round caps.
 * Counts are per model turn (same batch), in call order — first N run, rest block.
 *
 * @param {object[]} toolCalls
 * @param {Record<string, number>} [limits] - defaults to PER_ROUND_TOOL_LIMITS
 * @returns {Set<string>} tool_call ids to block
 */
function perRoundCappedDuplicateIds(toolCalls, limits = PER_ROUND_TOOL_LIMITS) {
  const blocked = new Set();
  const counts = new Map();
  if (!Array.isArray(toolCalls)) return blocked;
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    const max = limits[name];
    if (!name || !Number.isFinite(max) || max < 1) continue;
    const n = counts.get(name) || 0;
    if (n >= max) blocked.add(tc.id);
    else counts.set(name, n + 1);
  }
  return blocked;
}

function oncePerRoundErrorPayload(toolName) {
  return JSON.stringify({
    success: false,
    error: `"${toolName}" ${ONCE_PER_ROUND_ERROR}`,
  });
}

function perRoundCapErrorPayload(toolName, limit) {
  if (limit === 1) return oncePerRoundErrorPayload(toolName);
  return JSON.stringify({
    success: false,
    error: `"${toolName}" can only be called ${limit} time(s) per round. Use results from earlier calls in this round.`,
  });
}

/**
 * Run build sub-agent tools preserving assistant call order:
 *   - read_file / web_x_search / … run in parallel batches
 *   - write_file & edit_file run alone (sequential), flushing any pending batch first
 *   - bash runs when reached (after prior work), flushing any pending batch first
 *
 * @param {object[]} toolCalls - in model order
 * @param {function} runOne - async (tc) => tool result content
 * @returns {Promise<Map<string, unknown>>}
 */
async function executeBuildToolCallsOrdered(toolCalls, runOne) {
  const resultsById = new Map();
  let parBatch = [];

  const flushPar = async () => {
    if (!parBatch.length) return;
    await Promise.all(parBatch.map(async (tc) => {
      resultsById.set(tc.id, await runOne(tc));
    }));
    parBatch = [];
  };

  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (name === 'bash' || BUILD_MUTATING_TOOLS.has(name)) {
      await flushPar();
      resultsById.set(tc.id, await runOne(tc));
    } else {
      parBatch.push(tc);
    }
  }
  await flushPar();
  return resultsById;
}

module.exports = {
  parseToolCallArgs,
  isSendVoiceMessageToCurrentUser,
  partitionHandlerToolCalls,
  executeBuildToolCallsOrdered,
  BUILD_MUTATING_TOOLS,
  HANDLER_DELIVERY_TOOLS,
  ONCE_PER_ROUND_TOOL_NAMES,
  ONCE_PER_ROUND_ERROR,
  PER_ROUND_TOOL_LIMITS,
  oncePerRoundDuplicateIds,
  perRoundCappedDuplicateIds,
  oncePerRoundErrorPayload,
  perRoundCapErrorPayload,
};