// src/utils/toolCallExecution.js
//
// Shared helpers for ordering and batching tool calls within one model turn.

const { resolveActiveMemberByName } = require('../config/members');
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
    return true;
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

/**
 * @param {object[]} toolCalls - assistant tool_calls in model order
 * @param {object} userCtx
 * @returns {{ phase1: object[], phase2: object[] }}
 *   phase1: all tools in parallel (incl. send_email / send_whatsapp / voice to others)
 *   phase2: send_voice_message to current chat only (sequential, last; can end the turn)
 */
function partitionHandlerToolCalls(toolCalls, userCtx) {
  const phase1 = [];
  const phase2 = [];
  for (const tc of toolCalls) {
    if (isSendVoiceMessageToCurrentUser(tc, userCtx)) {
      phase2.push(tc);
    } else {
      phase1.push(tc);
    }
  }
  return { phase1, phase2 };
}

const BUILD_MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

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
};