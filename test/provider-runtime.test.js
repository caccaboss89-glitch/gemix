// test/provider-runtime.test.js
//
// Phase 9: the surfaces the completion bar names but the main call does not
// cover — startup preflight, the terminal error the user actually reads, the
// preference contract, the model footer and the research badge.
//
// The rule these share is the same one: nothing the OpenAI profile shows may
// name Grok, xAI, SuperGrok or a weekly renewal, and nothing the xAI profile
// shows may change at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub } from './helpers/fetchStub.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const { getProviderProfile, PROVIDER, profileFromContext } =
  await import('../src/ai/providers/providerProfile.js');
const { providerFailureReply } = await import('../src/ai/providers/errorPolicy.js');
const { runProviderPreflight } = await import('../src/ai/providers/preflight.js');
const { OPENAI_ERROR, makeOpenAiError } = await import('../src/ai/openaiResponsesTransport.js');
const { GROK_CREDIT_EXHAUSTED_MESSAGE } = await import('../src/config/systemMessages.js');
const { getModelDisplayName, buildResearchBadgeText, mergeResearchStats } = await import('../src/utils/footer.js');
const { effortsForProvider, defaultSettings, visibleSettingFields } =
  await import('../src/utils/settingsStore.js');
const { managePreferences } = await import('../src/tools/preferences.js');
const envConfig = (await import('../src/config/env.js')).default;

const XAI = getProviderProfile(PROVIDER.XAI);
const OPENAI = getProviderProfile(PROVIDER.OPENAI);

/** Everything the OpenAI profile is never allowed to say to a user. */
const XAI_WORDS = /grok|xai|x\.ai|supergrok|superGrok|rinnovo settimanale|𝕏/i;

// -- profileFromContext -------------------------------------------------------

test('a profile passed straight in is used, not the active one', () => {
  // Without this, every helper called with a profile instead of a context would
  // silently answer for whichever provider the process happens to run.
  assert.equal(profileFromContext(OPENAI).id, PROVIDER.OPENAI);
  assert.equal(profileFromContext(XAI).id, PROVIDER.XAI);
  assert.equal(profileFromContext({ providerProfile: OPENAI }).id, PROVIDER.OPENAI);
  assert.equal(profileFromContext({ providerId: PROVIDER.OPENAI }).id, PROVIDER.OPENAI);
  assert.equal(profileFromContext(null).id, envConfig.AI_PROVIDER);
});

// -- Terminal errors ----------------------------------------------------------

test('the SuperGrok credit notice answers only xAI errors', () => {
  const creditErr = new Error('Grok 4.5 API credit exhausted after 3 attempt(s): blocked');
  creditErr.code = 'GROK_CREDIT_EXHAUSTED';
  const reply = providerFailureReply(creditErr, XAI);
  assert.equal(reply.text, GROK_CREDIT_EXHAUSTED_MESSAGE);
});

test('an OpenAI error is never answered with the SuperGrok notice', () => {
  // Same wording, but tagged as coming from the other back end.
  const err = makeOpenAiError(OPENAI_ERROR.SUBSCRIPTION_LIMIT, 'API credit exhausted');
  const reply = providerFailureReply(err, OPENAI);
  assert.notEqual(reply, null);
  assert.doesNotMatch(reply.text, XAI_WORDS);
  assert.doesNotMatch(reply.logLine, /SuperGrok/);
});

test('the xAI branch ignores an error tagged as OpenAI even on its own profile', () => {
  const err = makeOpenAiError(OPENAI_ERROR.SUBSCRIPTION_LIMIT, 'API credit exhausted');
  assert.equal(providerFailureReply(err, XAI), null);
});

test('OpenAI 401/403/429 all get a neutral user message', () => {
  for (const kind of [OPENAI_ERROR.AUTH, OPENAI_ERROR.RATE_LIMIT, OPENAI_ERROR.SUBSCRIPTION_LIMIT]) {
    const reply = providerFailureReply(makeOpenAiError(kind, 'refused'), OPENAI);
    assert.notEqual(reply, null, `${kind} should have a message`);
    assert.doesNotMatch(reply.text, XAI_WORDS, `${kind} leaked an xAI reference`);
  }
});

test('a failure with nothing specific to say falls through to the generic reply', () => {
  assert.equal(providerFailureReply(new Error('socket hang up'), OPENAI), null);
  assert.equal(providerFailureReply(makeOpenAiError(OPENAI_ERROR.TRANSIENT, 'boom'), OPENAI), null);
  assert.equal(providerFailureReply(new Error('socket hang up'), XAI), null);
});

// -- Startup preflight --------------------------------------------------------

test('the xAI preflight pings the models route', async () => {
  const stub = installFetchStub(() => new Response('{}', { status: 200 }));
  try {
    await runProviderPreflight(XAI);
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/models$/);
  } finally {
    stub.restore();
  }
});

test('the OpenAI preflight checks the credential without spending a request', async () => {
  const stub = installFetchStub(() => { throw new Error('preflight must not call the API'); });
  try {
    await runProviderPreflight(OPENAI);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a preflight failure never throws the process down', async () => {
  const stub = installFetchStub(() => { throw new Error('network down'); });
  try {
    await runProviderPreflight(XAI);
    await runProviderPreflight(OPENAI);
  } finally {
    stub.restore();
  }
});

// -- Footer and badge ---------------------------------------------------------

test('the footer names the running model on each profile', () => {
  assert.equal(getModelDisplayName(OPENAI.model, { providerProfile: OPENAI }), OPENAI.displayName);
  assert.match(OPENAI.displayName, /^ChatGPT /);
  assert.doesNotMatch(OPENAI.displayName, XAI_WORDS);
  assert.equal(getModelDisplayName(XAI.model, { providerProfile: XAI }), XAI.displayName);
});

test('the research badge never shows an X count without X posts', () => {
  assert.equal(buildResearchBadgeText({ webSources: 3, xPosts: 0 }), '🌐: 3 sources.');
  assert.equal(buildResearchBadgeText({ webSources: 0, xPosts: 0 }), null);
  // The xAI branch keeps both halves.
  assert.equal(buildResearchBadgeText({ webSources: 1, xPosts: 2 }), '🌐: 1 source. 𝕏: 2 posts.');
});

test('OpenAI source URLs are deduplicated across tool rounds before the badge', () => {
  const first = mergeResearchStats(null, {
    webSources: 2,
    xPosts: 0,
    webSourceKeys: ['url:https://example.invalid/a', 'url:https://example.invalid/b']
  });
  const merged = mergeResearchStats(first, {
    webSources: 2,
    xPosts: 0,
    webSourceKeys: ['url:https://example.invalid/b', 'url:https://example.invalid/c']
  });
  assert.equal(merged.webSources, 3);
  assert.deepEqual(merged.webSourceKeys, [
    'url:https://example.invalid/a',
    'url:https://example.invalid/b',
    'url:https://example.invalid/c'
  ]);
  assert.equal(buildResearchBadgeText(merged), '🌐: 3 sources.');
});

// -- Preferences --------------------------------------------------------------

test('each profile exposes its own preference fields and effort levels', () => {
  assert.deepEqual(visibleSettingFields(XAI), ['voice', 'effort', 'language', 'memory']);
  assert.deepEqual(visibleSettingFields(OPENAI), ['effort', 'language', 'memory']);
  assert.deepEqual(effortsForProvider(XAI), ['low', 'medium', 'high']);
  assert.deepEqual(effortsForProvider(OPENAI), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(defaultSettings(XAI).effort, 'high');
  assert.equal(defaultSettings(OPENAI).effort, 'max');
  assert.equal(defaultSettings(OPENAI).voice, undefined);
});

test('manage_preferences refuses a voice on a profile that has none', async () => {
  const result = await managePreferences({ voice: 'luna' }, 'test-settings-id', OPENAI);
  assert.equal(result.success, false);
  assert.match(result.error, /no voice setting/);
  assert.doesNotMatch(result.error, XAI_WORDS);
});

test('manage_preferences accepts an effort the profile actually has', async () => {
  // `max` is an OpenAI level and not an xAI one: validating it against the
  // wrong list is exactly the bug this covers. No file is written because the
  // validation runs first and this id has none.
  const rejected = await managePreferences({ effort: 'max' }, 'test-settings-id', XAI);
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /Use one of: low, medium, high\./);

  const missingId = await managePreferences({ effort: 'max' }, '', OPENAI);
  assert.equal(missingId.success, false);
  assert.match(missingId.error, /settings file/);
});

test('manage_preferences lists only the fields the profile has when nothing was passed', async () => {
  const openai = await managePreferences({}, 'test-settings-id', OPENAI);
  assert.equal(openai.error, 'Nothing to update: pass at least one of effort, language, memory.');
  const xai = await managePreferences({}, 'test-settings-id', XAI);
  assert.equal(xai.error, 'Nothing to update: pass at least one of voice, effort, language, memory.');
});
