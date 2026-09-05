// test/provider-composition.test.js
//
// The separation the architecture rests on: wire capabilities gate whether a
// provider may drive the main brain while runtime bindings select the few
// provider-dependent media backends independently.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_WIRE_CAPABILITIES,
  defineWireCapabilities,
  validateWireCapabilities
} from '../src/ai/providers/wireCapabilities.js';
import {
  FEATURE,
  UNAVAILABLE,
  backendFor,
  defineFeatureBindings,
  fallbackBackendFor,
  isFeatureAvailable
} from '../src/features/featureBindings.js';
import { xaiResponsesExtensions, XAI_X_SEARCH_TOOL } from '../src/ai/extensions/xaiResponsesExtensions.js';
import { TRANSPORT_ERROR, classifyHttpFailure } from '../src/ai/transport/errors.js';
import { BASE_REPLAYABLE_ITEM_TYPES, buildResponsesBody } from '../src/ai/transport/responsesProtocol.js';
import envConfig from '../src/config/env.js';
import {
  PROMPT_VARIANT,
  getProviderProfile
} from '../src/ai/providers/providerProfile.js';

test('undeclared wire capabilities default to false', () => {
  const caps = defineWireCapabilities({ supportsResponses: true });
  assert.equal(caps.supportsResponses, true);
  assert.equal(caps.supportsSse, false);
  assert.throws(() => defineWireCapabilities({ madeUp: true }), /Unknown wire capability/);
});

test('max_output_tokens is declared per provider, and the Codex backend does not take it', () => {
  // A real regression: the Codex backend answers
  // "HTTP 400 UNSUPPORTED_INPUT: Unsupported parameter: max_output_tokens"
  // and fails the whole request, not just the parameter. Before this capability
  // existed the parameter went out on every call.
  assert.equal(getProviderProfile('chatgpt').wire.supportsMaxOutputTokens, false);
  assert.equal(getProviderProfile('xai').wire.supportsMaxOutputTokens, true);

  // Not part of the minimum contract: an endpoint that bounds the answer on its
  // own terms is still perfectly usable.
  assert.ok(!REQUIRED_WIRE_CAPABILITIES.includes('supportsMaxOutputTokens'));

  // The body must omit the key rather than send it as null: a key present with
  // a null value would be rejected all the same.
  const senzaTetto = buildResponsesBody({ model: 'm', input: [], maxOutputTokens: null });
  assert.ok(!('max_output_tokens' in senzaTetto));
  const conTetto = buildResponsesBody({ model: 'm', input: [], maxOutputTokens: 64000 });
  assert.equal(conTetto.max_output_tokens, 64000);
});

test('prompt_cache_key is optional and never assumed for a generic endpoint', () => {
  assert.equal(getProviderProfile('xai').wire.supportsPromptCacheKey, true);
  assert.equal(getProviderProfile('chatgpt').wire.supportsPromptCacheKey, true);
  assert.equal(getProviderProfile('openrouter').wire.supportsPromptCacheKey, false);
  assert.equal(getProviderProfile('custom').wire.supportsPromptCacheKey, false);
  assert.ok(!REQUIRED_WIRE_CAPABILITIES.includes('supportsPromptCacheKey'));
});

test('the ChatGPT display name strips provider implementation suffixes', () => {
  const saved = envConfig.CHATGPT_MODEL;
  envConfig.CHATGPT_MODEL = 'gpt-5.6-sol';
  try {
    assert.equal(getProviderProfile('chatgpt').displayName, 'ChatGPT 5.6');
  } finally {
    envConfig.CHATGPT_MODEL = saved;
  }
});

test('the minimum wire contract names every required flag', () => {
  assert.deepEqual([...REQUIRED_WIRE_CAPABILITIES].sort(), [
    'supportsFunctionCalling',
    'supportsImageInput',
    'supportsReasoningReplay',
    'supportsResponses',
    'supportsSse',
    'supportsStrictStructuredOutput'
  ]);
  const full = defineWireCapabilities({
    supportsResponses: true,
    supportsSse: true,
    supportsFunctionCalling: true,
    supportsStrictStructuredOutput: true,
    supportsReasoningReplay: true,
    supportsImageInput: true
  });
  assert.deepEqual(validateWireCapabilities(full), { ok: true, missing: [] });
  const noSse = defineWireCapabilities({ ...full, supportsSse: false });
  assert.deepEqual(validateWireCapabilities(noSse), { ok: false, missing: ['supportsSse'] });
});

test('feature bindings reject descriptive entries that runtime never dispatches', () => {
  assert.throws(() => defineFeatureBindings({ search_web: 'provider-hosted' }), /Unknown feature/);
});

test('a profile with no overrides gets the GemiX baselines', () => {
  const profile = { features: defineFeatureBindings({}) };
  assert.equal(backendFor(profile, FEATURE.GENERATE_IMAGE), 'cloudflare-flux');
  assert.equal(backendFor(profile, FEATURE.STT), 'cloudflare-whisper');
  assert.equal(backendFor(profile, FEATURE.GENERATE_VIDEO), UNAVAILABLE);
  assert.equal(isFeatureAvailable(profile, FEATURE.GENERATE_VIDEO), false);
});

test('provider-primary media backends fall back to the GemiX baseline', () => {
  assert.equal(fallbackBackendFor('xai-imagine-image'), 'cloudflare-flux');
  assert.equal(fallbackBackendFor('xai-stt'), 'cloudflare-whisper');
  assert.equal(fallbackBackendFor('cloudflare-flux'), null);
  assert.equal(fallbackBackendFor('xai-imagine-video'), null);
});

test('X search is a native type the extension owns, not a function tool', () => {
  assert.equal(XAI_X_SEARCH_TOOL.type, 'x_search');
  assert.equal('function' in XAI_X_SEARCH_TOOL, false);
});

test('the generic profile is the baseline and only xAI carries native extras', () => {
  const xai = getProviderProfile('xai');
  assert.equal(xai.promptVariant, PROMPT_VARIANT.XAI);
  assert.deepEqual(xai.nativeTools, [XAI_X_SEARCH_TOOL]);

  for (const id of ['chatgpt', 'openrouter', 'custom']) {
    const profile = getProviderProfile(id);
    assert.equal(profile.promptVariant, PROMPT_VARIANT.GENERIC);
    assert.deepEqual(profile.nativeTools, []);
  }
});

test('the xAI extension adds max_turns and the sticky-routing header, nothing standard', () => {
  const body = xaiResponsesExtensions.decorateBody({ model: 'm' }, { promptCacheKey: 'k', maxTurns: 7 });
  assert.equal(body.max_turns, 7);
  // prompt_cache_key and the reasoning include are standard Responses fields,
  // so the generic body builder owns them, not this extension.
  assert.equal('prompt_cache_key' in body, false);
  assert.equal('include' in body, false);

  const headers = xaiResponsesExtensions.decorateHeaders({}, { promptCacheKey: 'k' });
  assert.equal(headers['x-grok-conv-id'], 'k');

  const noTurns = xaiResponsesExtensions.decorateBody({ model: 'm' }, {});
  assert.equal('max_turns' in noTurns, false);
});

test('the xAI extension replays its own server-side item types on top of the base set', () => {
  for (const type of BASE_REPLAYABLE_ITEM_TYPES) {
    assert.ok(xaiResponsesExtensions.replayableItemTypes.includes(type));
  }
  assert.ok(xaiResponsesExtensions.replayableItemTypes.includes('custom_tool_call'));
  assert.ok(xaiResponsesExtensions.replayableItemTypes.includes('x_search_call'));
  assert.equal(xaiResponsesExtensions.replayableItemTypes.includes('web_search_call'), false);
});

test('the xAI extension distinguishes OAuth allowance exhaustion from an invalid API key', () => {
  const saved = envConfig.XAI_USE_API_KEY;
  const spending = '{"code":"personal-team-blocked:spending-limit"}';
  const unauthenticated = '{"code":"unauthenticated:bad-credentials"}';
  try {
    envConfig.XAI_USE_API_KEY = false;
    assert.equal(xaiResponsesExtensions.refineHttpFailure(403, spending), TRANSPORT_ERROR.QUOTA);
    assert.equal(xaiResponsesExtensions.refineHttpFailure(429, spending), TRANSPORT_ERROR.QUOTA);
    assert.equal(
      classifyHttpFailure(403, unauthenticated, xaiResponsesExtensions.refineHttpFailure),
      TRANSPORT_ERROR.QUOTA
    );

    envConfig.XAI_USE_API_KEY = true;
    assert.equal(xaiResponsesExtensions.refineHttpFailure(403, spending), TRANSPORT_ERROR.QUOTA);
    assert.equal(xaiResponsesExtensions.refineHttpFailure(403, unauthenticated), null);
    assert.equal(
      classifyHttpFailure(403, unauthenticated, xaiResponsesExtensions.refineHttpFailure),
      TRANSPORT_ERROR.AUTH
    );
    assert.equal(xaiResponsesExtensions.refineHttpFailure(403, 'plain forbidden'), null);
    assert.equal(xaiResponsesExtensions.refineHttpFailure(500, spending), null);
  } finally {
    envConfig.XAI_USE_API_KEY = saved;
  }
});

test('the xAI extension counts completed X calls without inventing result totals', () => {
  const stats = xaiResponsesExtensions.extractSearchStats({
    output: [
      { type: 'custom_tool_call', name: 'x_keyword_search', input: '{"limit":12}' },
      { type: 'custom_tool_call', name: 'x_thread_fetch', input: '{}' },
      { type: 'custom_tool_call', name: 'view_x_video', input: '{}' },
      { type: 'custom_tool_call', name: 'x_semantic_search', status: 'failed', input: '{"limit":50}' },
      { type: 'x_search_call', status: 'completed' },
      { type: 'x_search_call', status: 'failed' },
      { type: 'custom_tool_call', name: 'not_an_x_tool', input: '{"limit":99}' }
    ]
  });
  assert.deepEqual(stats, { webSources: 0, xSearches: 3 });
});
