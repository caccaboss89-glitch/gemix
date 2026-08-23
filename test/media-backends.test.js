// test/media-backends.test.js
//
// Media routing (§11.1), the per-backend tool schemas (§18.12), the neuron
// ledger at the real prices (§11.2) and the fallback rules (§18.13).
//
// The rule that matters most here is §18.13.2: a content-policy refusal is
// never retried on another backend. Everything else is about not lying to the
// model — a tool must not advertise a parameter its backend cannot honour.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { CF_ERROR, classifyFailure } from '../src/media/cloudflareClient.js';
import {
  BACKEND,
  FLUX_DEFAULT_SIZE,
  FLUX_MAX_REFERENCES,
  FLUX_SIZES,
  _resetCooldownsForTests,
  declaredImageBackend,
  failurePlan,
  resolveFluxSize,
  resolveImageBackends,
  startCooldown
} from '../src/media/imageBackends.js';
import {
  DAILY_NEURONS,
  LEDGER_FILE,
  NEURONS_PER_INPUT_TILE,
  NEURONS_PER_OUTPUT_TILE,
  RESERVE_NEURONS,
  canAfford,
  estimateImageNeurons,
  estimateSttNeurons,
  ledgerSnapshot,
  recordSpend,
  remainingNeurons,
  resetLedger,
  tilesFor
} from '../src/media/neuronLedger.js';
import { FEATURE, backendFor, isFeatureAvailable } from '../src/features/featureBindings.js';
import { _resetActiveProfileForTests, getProviderProfile } from '../src/ai/providers/providerProfile.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';

let ledgerBackup = null;

before(() => {
  try { ledgerBackup = fs.readFileSync(LEDGER_FILE, 'utf-8'); }
  catch { ledgerBackup = null; }
});

after(() => {
  if (ledgerBackup === null) { try { fs.unlinkSync(LEDGER_FILE); } catch { /* never existed */ } }
  else fs.writeFileSync(LEDGER_FILE, ledgerBackup);
});

beforeEach(() => {
  resetLedger();
  _resetCooldownsForTests();
});

// -- routing (§11.1) ----------------------------------------------------------

test('the xAI profile keeps its own media services, the others fall to the baseline', () => {
  const xai = getProviderProfile('xai');
  assert.equal(backendFor(xai, FEATURE.GENERATE_IMAGE), 'xai-imagine-image');
  assert.equal(backendFor(xai, FEATURE.GENERATE_VIDEO), 'xai-imagine-video');
  assert.equal(backendFor(xai, FEATURE.STT), 'xai-stt');
  assert.equal(backendFor(xai, FEATURE.TTS), 'xai-tts');
  assert.equal(backendFor(xai, FEATURE.X_SEARCH), 'xai-native');
});

test('a subscription backend is not treated as the whole product line', () => {
  // The Codex endpoint unlocks a Responses API, not OpenAI's image or audio
  // products, so those must resolve to the GemiX baselines.
  const chatgpt = getProviderProfile('chatgpt');
  assert.equal(backendFor(chatgpt, FEATURE.GENERATE_IMAGE), 'cloudflare-flux');
  assert.equal(backendFor(chatgpt, FEATURE.STT), 'cloudflare-whisper');
  assert.equal(backendFor(chatgpt, FEATURE.TTS), 'google-translate');
  assert.equal(isFeatureAvailable(chatgpt, FEATURE.GENERATE_VIDEO), false);
  assert.equal(isFeatureAvailable(chatgpt, FEATURE.X_SEARCH), false);
});

test('the search and workspace features stay GemiX-owned on every profile', () => {
  for (const id of ['xai', 'chatgpt']) {
    const profile = getProviderProfile(id);
    assert.equal(backendFor(profile, FEATURE.WEB_SEARCH), 'gemix-web');
    assert.equal(backendFor(profile, FEATURE.IMAGE_SEARCH), 'gemix-image-search');
    assert.equal(backendFor(profile, FEATURE.SHELL), 'gemix');
    assert.equal(backendFor(profile, FEATURE.MUSIC_GENERATION), 'openrouter-lyria');
  }
});

// -- backend selection --------------------------------------------------------

test('the declared backend is the one whose schema the tool should show', () => {
  const declared = declaredImageBackend();
  assert.ok(declared === BACKEND.XAI || declared === BACKEND.CLOUDFLARE || declared === null);
});

test('a cooled-down primary hands over to the fallback, and comes back after', () => {
  const before = resolveImageBackends();
  if (!before.primary || !before.fallback) return; // no chain on this deployment

  startCooldown(before.primary);
  const during = resolveImageBackends();
  assert.notEqual(during.primary, before.primary, 'the cooled backend is skipped');
  assert.equal(during.primary, before.fallback);

  _resetCooldownsForTests();
  assert.equal(resolveImageBackends().primary, before.primary);
});

// -- fallback policy (§18.13) -------------------------------------------------

test('a content-policy refusal is never routed around', () => {
  const plan = failurePlan(CF_ERROR.CONTENT_POLICY);
  assert.equal(plan.fallBack, false, 'the other backend must not be tried');
  assert.equal(plan.retryPrimary, false);
  assert.equal(plan.cooldown, false);
});

test('a rate limit falls back at once and stops probing the primary', () => {
  for (const code of [CF_ERROR.RATE_LIMIT, CF_ERROR.BUDGET]) {
    const plan = failurePlan(code);
    assert.equal(plan.fallBack, true, code);
    assert.equal(plan.retryPrimary, false, `${code} must not be retried`);
    assert.equal(plan.cooldown, true, code);
  }
});

test('a credential or transient failure earns one retry before the fallback', () => {
  for (const code of [CF_ERROR.AUTH, CF_ERROR.TRANSIENT]) {
    const plan = failurePlan(code);
    assert.equal(plan.retryPrimary, true, code);
    assert.equal(plan.fallBack, true, code);
    assert.equal(plan.cooldown, false, code);
  }
});

test('a malformed request is not repeated, but the other backend may still work', () => {
  const plan = failurePlan(CF_ERROR.MALFORMED);
  assert.equal(plan.retryPrimary, false);
  assert.equal(plan.fallBack, true);
});

test('HTTP statuses map onto the codes the policy reads', () => {
  assert.equal(classifyFailure(401, ''), CF_ERROR.AUTH);
  assert.equal(classifyFailure(403, ''), CF_ERROR.AUTH);
  assert.equal(classifyFailure(429, ''), CF_ERROR.RATE_LIMIT);
  assert.equal(classifyFailure(503, ''), CF_ERROR.TRANSIENT);
  assert.equal(classifyFailure(400, 'prompt violates our content policy'), CF_ERROR.CONTENT_POLICY);
  assert.equal(classifyFailure(400, 'bad field'), CF_ERROR.MALFORMED);
});

// -- FLUX sizes ---------------------------------------------------------------

test('a FLUX size resolves to real pixels, and an unknown one to the default', () => {
  assert.deepEqual(resolveFluxSize('landscape'), FLUX_SIZES.landscape);
  assert.deepEqual(resolveFluxSize('LANDSCAPE'), FLUX_SIZES.landscape);
  assert.deepEqual(resolveFluxSize('16:9'), FLUX_SIZES[FLUX_DEFAULT_SIZE], 'a ratio is not a FLUX size');
  assert.deepEqual(resolveFluxSize(undefined), FLUX_SIZES[FLUX_DEFAULT_SIZE]);
});

test('FLUX takes exactly one reference, which is what the schema must say', () => {
  assert.equal(FLUX_MAX_REFERENCES, 1);
});

// -- neuron ledger (§11.2) ----------------------------------------------------

test('image cost uses the probed prices, not the archive estimate', () => {
  // A 512x512 image is one output tile: ~26 neurons, not 250.
  assert.equal(tilesFor(512, 512), 1);
  assert.equal(estimateImageNeurons({ width: 512, height: 512 }), NEURONS_PER_OUTPUT_TILE);
  // 1024x1024 is four tiles: ~104.
  assert.equal(tilesFor(1024, 1024), 4);
  assert.equal(estimateImageNeurons({ width: 1024, height: 1024 }), 4 * NEURONS_PER_OUTPUT_TILE);
  // A reference is charged at the lower input rate on top.
  assert.equal(
    estimateImageNeurons({ width: 512, height: 512, inputImages: 2 }),
    NEURONS_PER_OUTPUT_TILE + 2 * NEURONS_PER_INPUT_TILE
  );
});

test('transcription is charged by audio length', () => {
  assert.ok(estimateSttNeurons(600) > estimateSttNeurons(60));
  assert.ok(estimateSttNeurons(0) > 0, 'a clip always costs something');
});

test('images and speech draw on one shared allowance', () => {
  const start = remainingNeurons();
  recordSpend(estimateImageNeurons({ width: 1024, height: 1024 }));
  const afterImage = remainingNeurons();
  assert.ok(afterImage < start);

  recordSpend(estimateSttNeurons(300));
  assert.ok(remainingNeurons() < afterImage, 'the transcription came out of the same pool');
});

test('the allowance is refused before the call, with the numbers in the message', () => {
  recordSpend(DAILY_NEURONS);
  const verdict = canAfford(50);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /allowance for today is spent/);
  assert.match(verdict.reason, /00:00 UTC/);
});

test('a reserve is kept back rather than spending down to the last neuron', () => {
  assert.equal(remainingNeurons(), DAILY_NEURONS - RESERVE_NEURONS);
  assert.equal(canAfford(DAILY_NEURONS - RESERVE_NEURONS).ok, true);
  assert.equal(canAfford(DAILY_NEURONS - RESERVE_NEURONS + 1).ok, false);
});

test('the count rolls over on the UTC day Cloudflare resets on', () => {
  recordSpend(500);
  assert.ok(ledgerSnapshot().spent >= 500);
  const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
  assert.equal(ledgerSnapshot(tomorrow).spent, 0);
  assert.equal(remainingNeurons(tomorrow), DAILY_NEURONS - RESERVE_NEURONS);
});

// -- what the model is actually offered (§18.12) ------------------------------
//
// The registry is read at call time, not at import time, so a profile swap here
// is enough to see the tool list the other deployment would get.

/** Run `fn` with a provider profile and Cloudflare state of our choosing. */
function withDeployment({ provider, cloudflare }, fn) {
  const saved = {
    provider: envConfig.AI_PROVIDER,
    account: envConfig.CLOUDFLARE_AI_ACCOUNT_ID,
    token: envConfig.CLOUDFLARE_AI_API_TOKEN
  };
  envConfig.AI_PROVIDER = provider;
  envConfig.CLOUDFLARE_AI_ACCOUNT_ID = cloudflare ? 'test-account' : '';
  envConfig.CLOUDFLARE_AI_API_TOKEN = cloudflare ? 'test-token' : '';
  _resetActiveProfileForTests();
  try { return fn(); }
  finally {
    envConfig.AI_PROVIDER = saved.provider;
    envConfig.CLOUDFLARE_AI_ACCOUNT_ID = saved.account;
    envConfig.CLOUDFLARE_AI_API_TOKEN = saved.token;
    _resetActiveProfileForTests();
  }
}

const whatsappCtx = { platform: constants.PLATFORM_WA_DEDICATED, isGroup: false };
// A provider-native tool is a bare `{ type }`; a function tool carries a schema.
const nameOf = (tool) => tool.function?.name || tool.type;
const names = (tools) => tools.map(nameOf);
const paramsOf = (tools, name) => {
  const found = tools.find((t) => nameOf(t) === name);
  return found?.function ? Object.keys(found.function.parameters.properties) : null;
};

test('on xAI the model sees the provider-native tools and the ratio schema', () => {
  const tools = withDeployment({ provider: 'xai', cloudflare: true },
    () => getToolsForUser(true, false, whatsappCtx));

  assert.ok(names(tools).includes('x_search'));
  assert.ok(names(tools).includes('generate_video'));
  assert.deepEqual(paramsOf(tools, 'generate_image'), ['prompt', 'reference_images', 'aspect_ratio']);
});

test('on a profile without them, the native tools are absent rather than broken', () => {
  const tools = withDeployment({ provider: 'chatgpt', cloudflare: true },
    () => getToolsForUser(true, false, whatsappCtx));

  assert.equal(names(tools).includes('x_search'), false, 'X search is xAI-specific');
  assert.equal(names(tools).includes('generate_video'), false, 'no video backend, no tool');
  // FLUX takes a named size, not a ratio: offering aspect_ratio here would be a
  // parameter the backend silently drops.
  assert.deepEqual(paramsOf(tools, 'generate_image'), ['prompt', 'reference_images', 'size']);
});

test('with no image backend at all the tool is withheld, not left to fail', () => {
  const tools = withDeployment({ provider: 'chatgpt', cloudflare: false },
    () => getToolsForUser(true, false, whatsappCtx));

  assert.equal(paramsOf(tools, 'generate_image'), null);
  assert.ok(names(tools).includes('generate_music'), 'music has its own backend and stays');
});

test('the GemiX-owned tools are on every profile', () => {
  for (const provider of ['xai', 'chatgpt']) {
    const tools = withDeployment({ provider, cloudflare: false },
      () => getToolsForUser(true, false, whatsappCtx));
    for (const name of ['web_search', 'web_image_search', 'read_file', 'shell']) {
      assert.ok(names(tools).includes(name), `${name} missing on ${provider}`);
    }
  }
});
