// src/ai/aiProvider.js
//
// The main brain's single entry point: one Responses call, whichever provider
// profile is active.
//
// It owns the composition and nothing else — resolve the profile, build the
// body from the profile's model/effort/extension, hand it to the one transport,
// read the assembled response back. Provider differences reach the wire only
// through `profile.extensions`; feature routing never passes through here at
// all.
//
// The transport and the credential provider are built once per process: a
// profile cannot change mid-run, and rebuilding a credential provider per call
// would throw away its refresh state and its pool bookkeeping.

import constants from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { resolveProviderProfile } from './providers/providerProfile.js';
import { OpenAIResponsesTransport } from './transport/openAIResponsesTransport.js';
import {
  BASE_REPLAYABLE_ITEM_TYPES,
  buildResponsesBody,
  buildResponsesInput,
  readResponse,
  toolsToWire
} from './transport/responsesProtocol.js';

const log = createLogger('AI');

let _transport = null;
let _credentialProvider = null;

/** The credential provider for the active profile, built once. */
function getCredentialProvider() {
  if (!_credentialProvider) {
    _credentialProvider = resolveProviderProfile().createCredentialProvider();
  }
  return _credentialProvider;
}

/** The transport for the active profile, built once. */
function getTransport() {
  if (!_transport) {
    const profile = resolveProviderProfile();
    _transport = new OpenAIResponsesTransport({
      credentialProvider: getCredentialProvider(),
      baseUrl: profile.baseUrl,
      extensions: profile.extensions,
      label: profile.id
    });
  }
  return _transport;
}

/**
 * The reasoning effort for this call: the per-chat setting when the profile
 * accepts it, else the profile default. Providers do not agree on the ladder,
 * so the profile's `supportedEfforts` remains the wire-level authority.
 */
function _resolveEffort(profile, requested) {
  return profile.supportedEfforts.includes(requested) ? requested : profile.defaultEffort;
}

/**
 * Run one round of the agent loop against the active provider.
 *
 * @param {Array} items - the conversation for this round, as Responses-native
 *   items (see ai/responsesItems.js). There is no other accepted shape.
 * @param {Array|null} tools - GemiX tool definitions plus any native tool the
 *   profile's feature bindings enabled.
 * @param {object} [opts]
 * @param {object} [opts.responseFormat] - strict json_schema for the final reply
 * @param {string} [opts.toolChoice]
 * @param {string} [opts.reasoningEffort]
 * @param {string|null} [opts.promptCacheKey]
 * @param {number} [opts.maxTurns]
 * @param {string|null} [opts.requestId]
 * @param {import('../utils/turnBudget.js').TurnBudget|null} [opts.budget]
 * @returns {Promise<{ reply: {text: string, toolCalls: Array, items: Array},
 *   provider: string, model: string, searchStats: object }>}
 */
async function callAI(items, tools = null, opts = {}) {
  const profile = resolveProviderProfile();
  const transport = getTransport();
  const replayableItemTypes = profile.extensions?.replayableItemTypes || BASE_REPLAYABLE_ITEM_TYPES;

  const context = {
    promptCacheKey: opts.promptCacheKey || null,
    maxTurns: Number.isFinite(opts.maxTurns) ? opts.maxTurns : undefined,
    requestId: opts.requestId || null
  };

  const body = buildResponsesBody({
    model: profile.model,
    input: buildResponsesInput(items, { replayableItemTypes }),
    reasoningEffort: _resolveEffort(profile, opts.reasoningEffort),
    tools: toolsToWire(tools),
    toolChoice: opts.toolChoice || 'auto',
    responseFormat: opts.responseFormat || null,
    maxOutputTokens: constants.MAX_TOKENS,
    promptCacheKey: opts.promptCacheKey || null,
    // Stateless reasoning replay: the encrypted chain has to come back on the
    // response or the next round starts the model's thinking from scratch.
    include: profile.wire.supportsReasoningReplay ? ['reasoning.encrypted_content'] : null
  });

  // The transport hands back the assembled response inside an envelope that
  // also carries the upstream request id and usage; the response itself is what
  // the protocol reader takes.
  const { response } = await transport.createResponse({
    body,
    budget: opts.budget || null,
    requestId: opts.requestId || null,
    context
  });

  const read = readResponse(response, { replayableItemTypes });
  const searchStats = profile.extensions?.extractSearchStats
    ? profile.extensions.extractSearchStats(response)
    : { webSources: 0, xPosts: 0 };

  if (read.incompleteReason) {
    log.warn(`   response incomplete (${read.incompleteReason})`);
  }

  // What the round produced, in the same item language the request was built
  // in: `items` is what goes back into the conversation, `text` and `toolCalls`
  // are the two things the loop has to decide on.
  const reply = {
    text: read.text,
    toolCalls: read.toolCalls,
    items: read.replayItems
  };

  return { reply, provider: profile.displayName, model: profile.model, searchStats };
}

/** Reset the memoized transport and credentials. Tests only. */
function _resetProviderClientForTests() {
  _transport = null;
  _credentialProvider = null;
}

/**
 * Install a transport for the process. Tests only: it is what lets the seam
 * between the transport and this module be exercised without a live provider.
 */
function _setTransportForTests(transport) {
  _transport = transport;
}

export {
  callAI,
  getCredentialProvider,
  getTransport,
  _resetProviderClientForTests,
  _setTransportForTests
};
