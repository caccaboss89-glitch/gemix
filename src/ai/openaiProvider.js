// src/ai/openaiProvider.js
//
// Main-brain calls on the ChatGPT Codex Responses backend.
//
// The whole 30-message window is rebuilt on every request: this backend rejects
// `store: true` and `previous_response_id`, and rebuilding is what makes turns
// that fall out of the window actually disappear.
//
// Nothing in this path reaches xAI — not auth, not upload, not the stale-URL
// retry, not the prompt cache key, not the credit-exhaustion notice.

import constants from '../config/constants.js';
import { effortsForProvider } from '../utils/settingsStore.js';
import { getProviderProfile, PROVIDER } from './providers/providerProfile.js';
import {
  buildResponsesInput,
  buildResponsesBody,
  toolsToWire,
  responseToAssistantMessage,
  extractSearchStats,
  collectCitations
} from './openaiResponsesProtocol.js';
import { TurnBudget, callCodexResponses } from './openaiResponsesTransport.js';

/** Wall-clock budget for one Responses call, matching the xAI request timeout. */
const CALL_TIMEOUT_MS = constants.API_TIMEOUT_MS;

/**
 * Call GPT-5.6 Sol on the Codex Responses endpoint.
 *
 * @param {Array} messages - static system first, then history, the current user
 *   message, the Runtime block, then the tool items appended during the turn.
 * @param {Array|null} tools
 * @param {object} [opts]
 * @param {object} [opts.providerProfile] - the turn's immutable profile
 * @param {object} [opts.responseFormat] - GemiX structured-output schema
 * @param {string} [opts.reasoningEffort] - per-chat preference; profile default when unset
 * @param {string} [opts.toolChoice]
 * @param {string} [opts.requestId] - GemiX request id, for log correlation
 * @param {AbortSignal} [opts.signal] - turn-level cancellation
 * @returns {Promise<{message: object, provider: string, model: string, searchStats: object, citations: Array}>}
 */
async function callAI(messages, tools = null, opts = {}) {
  const profile = opts.providerProfile?.id === PROVIDER.OPENAI
    ? opts.providerProfile
    : getProviderProfile(PROVIDER.OPENAI);

  const allowedEfforts = effortsForProvider(profile);
  const effort = allowedEfforts.includes(opts.reasoningEffort)
    ? opts.reasoningEffort
    : profile.defaultEffort;

  const body = buildResponsesBody({
    model: profile.model,
    effort,
    input: buildResponsesInput(messages),
    tools: toolsToWire(tools),
    toolChoice: opts.toolChoice || 'auto',
    responseFormat: opts.responseFormat || null
  });

  const budget = new TurnBudget(CALL_TIMEOUT_MS, opts.signal);
  try {
    const { response } = await callCodexResponses({
      body,
      budget,
      requestId: opts.requestId || null
    });

    return {
      message: responseToAssistantMessage(response),
      provider: profile.displayName,
      model: profile.model,
      searchStats: extractSearchStats(response),
      citations: collectCitations(response)
    };
  } finally {
    budget.dispose();
  }
}

export { callAI };
