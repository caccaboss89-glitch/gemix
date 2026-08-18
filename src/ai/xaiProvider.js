// src/ai/xaiProvider.js
//
// Main-brain LLM calls on the direct xAI Responses endpoint (`/v1/responses`).
// Accepts the usual chat-style messages + tools and translates them through
// responsesAdapter + apiClient, then converts the result back to the
// chat-completion shape expected by handler.js.
//
// This file and the stack under it (apiClient, responsesAdapter,
// responsesWithUrlRefresh, promptCacheKey, xaiUpload) are xAI-only: the OpenAI
// profile has its own transport and never reaches any of them.

import envConfig from '../config/env.js';
import constants from '../config/constants.js';
import { VALID_EFFORTS  } from '../utils/settingsStore.js';
import { applyResponsesTextFormat  } from './responseSchema.js';
import {
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats
} from './responsesAdapter.js';
import { callResponsesWithStaleUrlRetry  } from './responsesWithUrlRefresh.js';

/**
 * @param {object} body
 * @param {string|null|undefined} key
 */
function _applyPromptCacheKey(body, key) {
  if (key && typeof key === 'string') {
    body.prompt_cache_key = key;
  }
}

/**
 * Call Grok on the direct xAI Responses endpoint.
 * @param {Array} messages - Static system first (only role:system), then
 *   history, the user message and the Runtime block (both role:user), then
 *   tool items. xAI prefix-cache matches from the start of this list (`input[]`).
 * @param {Array|null} tools
 * @param {object} [opts]
 * @param {string|null} [opts.historyStorageId] - Enables automatic refresh of
 *   expired tmpfile.link URLs referenced in messages before failing.
 * @param {string|null} [opts.promptCacheKey] - Stable per-conversation xAI cache id.
 * @param {string} [opts.reasoningEffort] - 'low' | 'medium' | 'high' (default 'high').
 */
async function callAI(messages, tools = null, opts = {}) {
  const logExtra = opts.requestId ? { requestId: opts.requestId } : {};

  const body = {
    model: envConfig.GROK_MODEL,
    max_output_tokens: constants.MAX_TOKENS,
    // Per-chat setting (manage_preferences), 'high' when unset.
    reasoning: { effort: VALID_EFFORTS.includes(opts.reasoningEffort) ? opts.reasoningEffort : 'high' },
    store: false
  };
  _applyPromptCacheKey(body, opts.promptCacheKey);

  if (envConfig.XAI_REASONING_REPLAY) {
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
    historyStorageId: opts.historyStorageId || null
  });

  const message = responsesToAssistantMessage(data);
  const searchStats = extractServerSearchStats(data);
  // imageResults/citations stay empty here: xAI renders its own inline
  // citations and image search runs as a client tool, not a hosted one.
  return {
    message,
    provider: 'Grok',
    model: envConfig.GROK_MODEL,
    searchStats,
    imageResults: [],
    citations: []
  };
}

export { callAI
};
