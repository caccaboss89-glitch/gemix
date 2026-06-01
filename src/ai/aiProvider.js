// src/ai/aiProvider.js
//
// Thin adapter for main-brain LLM calls.
// Talks to Hermes via the xAI Responses endpoint (`/v1/responses`).
// Accepts the usual chat-style messages + tools and translates them
// through responsesAdapter + apiClient, then converts the result back
// to the chat-completion shape expected by handler.js.
//
// Supports native multimodal input via input_file.

const { HERMES_API_KEY, HERMES_BASE_URL, GROK_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callResponsesModel } = require('./apiClient');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
} = require('./responsesAdapter');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

/**
 * Call Grok via the Hermes proxy on the Responses endpoint.
 * @param {Array} messages - Chat-completion-format messages array (string or array
 *   content; tool_calls/tool_call_id supported). Adapter handles translation.
 * @param {Array|null} tools - Chat-completion tool definitions. Adapter flattens
 *   them into Responses-shape function tools; native server-side tools
 *   (e.g. {type:'code_interpreter'}) pass through unchanged.
 * @param {object} [opts]
 * @param {string|object} [opts.toolChoice] - Override tool_choice (e.g. 'required'
 *   or {type:'function', name:'set_conversation_title'} to force a specific tool).
 * @param {number} [opts.maxTurns] - max_turns for server-side tool loops.
 * @returns {Promise<{message: object, provider: string, model: string}>}
 */
async function callAI(messages, tools = null, opts = {}) {
  const { instructions, input } = chatMessagesToResponsesInput(messages);

  const body = {
    model: GROK_MODEL,
    input,
    // max_output_tokens is the Responses API counterpart of max_tokens.
    max_output_tokens: MAX_TOKENS,
    // High reasoning effort: GemiX is the user-facing brain, latency is
    // dominated by tool I/O, and extra reasoning budget is used to avoid
    // shipping sloppy answers. webXSearch / buildAgent use the same.
    reasoning: { effort: 'high' },
  };

  // max_turns bounds xAI server-side tool turns (web_search/x_search/
  // code_interpreter) within a single request, so a runaway server-side
  // loop can't stall the call. Client-side function tools reset this counter
  // (per xAI docs), so our own outer loop in handler.js is the real bound.
  if (Number.isFinite(opts.maxTurns)) {
    body.max_turns = opts.maxTurns;
  }

  // Only attach instructions when we actually have a system prompt; xAI tolerates
  // an empty string but the omission is a touch cleaner in the request log.
  if (instructions && instructions.length > 0) {
    body.instructions = instructions;
  }

  const adaptedTools = chatToolsToResponsesTools(tools);
  if (adaptedTools) {
    body.tools = adaptedTools;
    // tool_choice defaults to "auto". Callers can force a
    // specific tool (e.g. the Discord title-setter on the first turn).
    body.tool_choice = opts.toolChoice || 'auto';
  }

  const data = await callResponsesModel('Grok', RESPONSES_URL, body, HERMES_API_KEY);
  const message = responsesToAssistantMessage(data);
  return { message, provider: 'Grok', model: GROK_MODEL };
}

module.exports = { callAI };
