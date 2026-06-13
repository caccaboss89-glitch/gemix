// src/ai/aiProvider.js
//
// Thin adapter for main-brain LLM calls on the direct xAI Responses
// endpoint (`/v1/responses`). Accepts the usual chat-style messages + tools
// and translates them through responsesAdapter + apiClient, then converts
// the result back to the chat-completion shape expected by handler.js.
//
// Supports native multimodal input (input_text / input_image / input_file),
// native server-side tools (web_search, x_search, code_interpreter) and
// structured output via response_format json_schema.

const { GROK_MODEL, XAI_REASONING_REPLAY } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callResponsesModel } = require('./apiClient');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats,
} = require('./responsesAdapter');

/**
 * Call Grok on the direct xAI Responses endpoint.
 * @param {Array} messages - Chat-completion-format messages array (string or array
 *   content; tool_calls/tool_call_id supported). Adapter handles translation.
 * @param {Array|null} tools - Chat-completion tool definitions. Adapter flattens
 *   them into Responses-shape function tools; native server-side tools
 *   (e.g. {type:'web_search'}) pass through unchanged.
 * @param {object} [opts]
 * @param {string|object} [opts.toolChoice] - Override tool_choice (e.g. 'none'
 *   for the forced final wrap-up call).
 * @param {number} [opts.maxTurns] - max_turns for server-side tool loops.
 * @param {object|null} [opts.responseFormat] - response_format payload
 *   (json_schema) when the reply must be structured.
 * @returns {Promise<{message: object, provider: string, model: string,
 *   searchStats: {webSources: number, xPosts: number}}>}
 */
async function callAI(messages, tools = null, opts = {}) {
  const logExtra = opts.requestId ? { requestId: opts.requestId } : {};
  const { instructions, input } = chatMessagesToResponsesInput(messages);

  const body = {
    model: GROK_MODEL,
    input,
    // max_output_tokens is the Responses API counterpart of max_tokens.
    max_output_tokens: MAX_TOKENS,
    // High reasoning effort: GemiX is the user-facing brain, latency is
    // dominated by tool I/O, and extra reasoning budget is used to avoid
    // shipping sloppy answers. The build sub-agent uses the same.
    reasoning: { effort: 'high' },
    // Local conversation state (handler tool loop): do not rely on xAI server store.
    store: false,
  };

  if (XAI_REASONING_REPLAY) {
    body.include = ['reasoning.encrypted_content'];
  }

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
    body.tool_choice = opts.toolChoice || 'auto';
  }

  if (opts.responseFormat) {
    body.response_format = opts.responseFormat;
  }

  const data = await callResponsesModel('Grok', body, logExtra);
  const message = responsesToAssistantMessage(data);
  const searchStats = extractServerSearchStats(data);
  return { message, provider: 'Grok', model: GROK_MODEL, searchStats };
}

module.exports = { callAI };
