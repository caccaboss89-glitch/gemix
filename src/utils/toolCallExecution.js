// src/utils/toolCallExecution.js
//
// Shared helpers for ordering and batching tool calls within one model turn.

const {
  MAX_GENERATE_IMAGE_PER_ROUND,
  MAX_GENERATE_VIDEO_PER_ROUND,
} = require('../config/constants');

function parseToolCallArgs(tc) {
  const raw = JSON.parse(tc.function.arguments || '{}');
  const args = {};
  for (const key of Object.keys(raw)) {
    args[key.trim()] = raw[key];
  }
  return args;
}

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

/** Per-round caps for main-brain tools (handler + tools/index.js). */
const PER_ROUND_TOOL_LIMITS = {
  read_music_stats: 1,
  read_server_rules: 1,
  build: 1,
  generate_image: MAX_GENERATE_IMAGE_PER_ROUND,
  generate_video: MAX_GENERATE_VIDEO_PER_ROUND,
};

const ONCE_PER_ROUND_ERROR =
  'can only be called once per round. Use the result from the previous call in this round.';

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

module.exports = {
  parseToolCallArgs,
  partitionHandlerToolCalls,
  HANDLER_DELIVERY_TOOLS,
  ONCE_PER_ROUND_ERROR,
  PER_ROUND_TOOL_LIMITS,
  perRoundCappedDuplicateIds,
  perRoundCapErrorPayload,
};