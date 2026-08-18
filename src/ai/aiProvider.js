// src/ai/aiProvider.js
//
// Router for main-brain LLM calls. It resolves nothing on its own: the caller
// passes the turn's immutable ProviderProfile and this file only picks the
// implementation that profile names.
//
// Both branches return the same shape — { message, provider, model,
// searchStats, imageResults, citations } — so the handler loop never has to
// know which back end answered.

import { PROVIDER, profileFromContext } from './providers/providerProfile.js';
import { callAI as callXai } from './xaiProvider.js';
import { callAI as callOpenAi } from './openaiProvider.js';

const IMPLEMENTATIONS = {
  [PROVIDER.XAI]: callXai,
  [PROVIDER.OPENAI]: callOpenAi
};

/**
 * Call the active provider's main brain.
 * @param {Array} messages
 * @param {Array|null} tools
 * @param {object} [opts] - carries providerProfile plus the per-call options
 *   the selected implementation understands.
 * @returns {Promise<{message: object, provider: string, model: string, searchStats: object, imageResults: Array, citations: Array}>}
 */
async function callAI(messages, tools = null, opts = {}) {
  const profile = profileFromContext(opts);
  const impl = IMPLEMENTATIONS[profile.id];
  if (!impl) throw new Error(`No main-brain implementation for provider "${profile.id}".`);
  return impl(messages, tools, { ...opts, providerProfile: profile });
}

export { callAI };
