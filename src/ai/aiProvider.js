// src/ai/aiProvider.js
//
// Thin adapter for main-brain LLM calls on the direct xAI Responses
// endpoint (`/v1/responses`). Accepts the usual chat-style messages + tools
// and translates them through responsesAdapter + apiClient, then converts
// the result back to the chat-completion shape expected by handler.js.

const { GROK_MODEL, XAI_REASONING_REPLAY } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { applyResponsesTextFormat } = require('./responseSchema');
const {
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats,
} = require('./responsesAdapter');
const { callResponsesWithStaleUrlRetry } = require('./responsesWithUrlRefresh');

/**
 * Call Grok on the direct xAI Responses endpoint.
 * @param {Array} messages
 * @param {Array|null} tools
 * @param {object} [opts]
 * @param {string|null} [opts.historyStorageId] - Enables automatic refresh of
 *   expired tmpfile.link URLs referenced in messages before failing.
 */
async function callAI(messages, tools = null, opts = {}) {
  const logExtra = opts.requestId ? { requestId: opts.requestId } : {};

  const body = {
    model: GROK_MODEL,
    max_output_tokens: MAX_TOKENS,
    reasoning: { effort: 'high' },
    store: false,
  };

  if (XAI_REASONING_REPLAY) {
    body.include = ['reasoning.encrypted_content'];
  }

  if (Number.isFinite(opts.maxTurns)) {
    body.max_turns = opts.maxTurns;
  }

  const adaptedTools = chatToolsToResponsesTools(tools);
  if (adaptedTools) {
    body.tools = adaptedTools;
    body.tool_choice = opts.toolChoice || 'auto';
  }

  applyResponsesTextFormat(body, opts.responseFormat);

  const data = await callResponsesWithStaleUrlRetry({
    modelName: 'Grok',
    messages,
    body,
    logExtra,
    historyStorageId: opts.historyStorageId || null,
  });

  const message = responsesToAssistantMessage(data);
  const searchStats = extractServerSearchStats(data);
  return { message, provider: 'Grok', model: GROK_MODEL, searchStats };
}

module.exports = { callAI };
