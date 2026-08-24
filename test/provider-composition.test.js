// test/provider-composition.test.js
//
// The separation the architecture rests on: wire capabilities gate whether a
// provider may drive the main brain, feature bindings decide who implements
// each user feature, and neither can quietly take over the other's job.

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
import { TRANSPORT_ERROR } from '../src/ai/transport/errors.js';
import { BASE_REPLAYABLE_ITEM_TYPES } from '../src/ai/transport/responsesProtocol.js';
import envConfig from '../src/config/env.js';
import { getProviderProfile } from '../src/ai/providers/providerProfile.js';

test('undeclared wire capabilities default to false', () => {
  const caps = defineWireCapabilities({ supportsResponses: true });
  assert.equal(caps.supportsResponses, true);
  assert.equal(caps.supportsSse, false);
  assert.equal(caps.nativeAudioInput, false);
  assert.throws(() => defineWireCapabilities({ madeUp: true }), /Unknown wire capability/);
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

test('GemiX-owned features cannot be bound to a provider backend', () => {
  for (const feature of [FEATURE.SEARCH_WEB, FEATURE.READ_PAGE, FEATURE.SEARCH_IMAGE,
    FEATURE.WORKSPACE, FEATURE.FILESYSTEM, FEATURE.SHELL, FEATURE.MUSIC_GENERATION]) {
    assert.throws(
      () => defineFeatureBindings({ [feature]: 'provider-hosted' }),
      /GemiX-owned/,
      `${feature} must stay GemiX-owned`
    );
  }
});

test('a profile with no overrides gets the GemiX baselines', () => {
  const profile = { features: defineFeatureBindings({}) };
  assert.equal(backendFor(profile, FEATURE.SEARCH_WEB), 'gemix-web');
  assert.equal(backendFor(profile, FEATURE.SEARCH_IMAGE), 'gemix-image-search');
  assert.equal(backendFor(profile, FEATURE.MUSIC_GENERATION), 'openrouter-lyria');
  assert.equal(backendFor(profile, FEATURE.GENERATE_IMAGE), 'cloudflare-flux');
  assert.equal(backendFor(profile, FEATURE.STT), 'cloudflare-whisper');
  assert.equal(backendFor(profile, FEATURE.TTS), 'google-translate');
  assert.equal(backendFor(profile, FEATURE.X_SEARCH), UNAVAILABLE);
  assert.equal(backendFor(profile, FEATURE.GENERATE_VIDEO), UNAVAILABLE);
  assert.equal(isFeatureAvailable(profile, FEATURE.GENERATE_VIDEO), false);
});

test('provider-primary media backends fall back to the GemiX baseline', () => {
  assert.equal(fallbackBackendFor('xai-imagine-image'), 'cloudflare-flux');
  assert.equal(fallbackBackendFor('xai-stt'), 'cloudflare-whisper');
  assert.equal(fallbackBackendFor('xai-tts'), 'google-translate');
  assert.equal(fallbackBackendFor('cloudflare-flux'), null);
  assert.equal(fallbackBackendFor('xai-imagine-video'), null);
});

test('X search is a native type the extension owns, not a function tool', () => {
  assert.equal(XAI_X_SEARCH_TOOL.type, 'x_search');
  assert.equal('function' in XAI_X_SEARCH_TOOL, false);
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
});

test('the xAI extension reads a spent allowance as QUOTA, not as an auth problem', () => {
  const spending = '{"code":"personal-team-blocked:spending-limit"}';
  assert.equal(xaiResponsesExtensions.refineHttpFailure(403, spending), TRANSPORT_ERROR.QUOTA);
  assert.equal(xaiResponsesExtensions.refineHttpFailure(429, spending), TRANSPORT_ERROR.QUOTA);
  assert.equal(
    xaiResponsesExtensions.refineHttpFailure(403, '{"code":"unauthenticated:bad-credentials"}'),
    TRANSPORT_ERROR.QUOTA
  );
  assert.equal(xaiResponsesExtensions.refineHttpFailure(403, 'plain forbidden'), null);
  assert.equal(xaiResponsesExtensions.refineHttpFailure(500, spending), null);
});

test('the xAI extension counts X posts and leaves web sources to GemiX', () => {
  const stats = xaiResponsesExtensions.extractSearchStats({
    output: [
      { type: 'custom_tool_call', name: 'x_keyword_search', input: '{"limit":12}' },
      { type: 'custom_tool_call', name: 'x_thread_fetch', input: '{}' },
      { type: 'custom_tool_call', name: 'not_an_x_tool', input: '{"limit":99}' },
      { type: 'web_search_call', action: { sources: ['https://a', 'https://b'] } }
    ]
  });
  assert.deepEqual(stats, { webSources: 0, xPosts: 13 });
});
