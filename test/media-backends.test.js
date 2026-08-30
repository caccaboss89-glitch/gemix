// test/media-backends.test.js
//
// Media routing, per-backend tool schemas, account rotation and fallback rules.
//
// The rule that matters most here is that a content-policy refusal is
// never retried on another backend. Everything else is about not lying to the
// model — a tool must not advertise a parameter its backend cannot honour.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import { CF_ERROR, EXHAUSTED_POOL_ERROR, classifyFailure } from '../src/media/cloudflareClient.js';
import {
  BACKEND,
  FLUX_DEFAULT_SIZE,
  FLUX_MAX_REFERENCES,
  FLUX_SIZES,
  XAI_ASPECT_TO_FLUX_SIZE,
  _resetCooldownsForTests,
  canUseImageFallback,
  declaredImageBackend,
  failurePlan,
  fluxSizeForAspectRatio,
  resolveFluxSize,
  resolveImageBackends,
  startCooldown
} from '../src/media/imageBackends.js';
import {
  CLOUDFLARE_STATE_FILE,
  isCloudflareConfigured,
  markExhausted as markAccountExhausted,
  markWorking as markAccountWorking,
  usableAccounts
} from '../src/media/cloudflareAccounts.js';
import { _runImageChain } from '../src/tools/imagineGenerator.js';
import { FEATURE, backendFor, isFeatureAvailable } from '../src/features/featureBindings.js';
import { _resetActiveProfileForTests, getProviderProfile } from '../src/ai/providers/providerProfile.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';

/** Two accounts, so rotation has somewhere to rotate to. */
const ACCOUNT_POOL = [
  { accountId: 'cf-account-1', apiToken: 'cf-token-1' },
  { accountId: 'cf-account-2', apiToken: 'cf-token-2' }
];

let ringBackup = null;
let accountsBackup = null;

before(() => {
  try { ringBackup = fs.readFileSync(CLOUDFLARE_STATE_FILE, 'utf-8'); }
  catch { ringBackup = null; }
  accountsBackup = envConfig.CLOUDFLARE_AI_ACCOUNTS;
});

after(() => {
  envConfig.CLOUDFLARE_AI_ACCOUNTS = accountsBackup;
  if (ringBackup === null) { try { fs.unlinkSync(CLOUDFLARE_STATE_FILE); } catch { /* never existed */ } }
  else fs.writeFileSync(CLOUDFLARE_STATE_FILE, ringBackup);
});

beforeEach(() => {
  _resetCooldownsForTests();
  envConfig.CLOUDFLARE_AI_ACCOUNTS = ACCOUNT_POOL.map(account => ({ ...account }));
  try { fs.unlinkSync(CLOUDFLARE_STATE_FILE); } catch { /* already absent */ }
});

// -- routing -----------------------------------------------------------------

test('the xAI profile keeps its own media services, the others fall to the baseline', () => {
  const xai = getProviderProfile('xai');
  assert.equal(backendFor(xai, FEATURE.GENERATE_IMAGE), 'xai-imagine-image');
  assert.equal(backendFor(xai, FEATURE.GENERATE_VIDEO), 'xai-imagine-video');
  assert.equal(backendFor(xai, FEATURE.STT), 'xai-stt');
});

test('a subscription backend is not treated as the whole product line', () => {
  // The Codex endpoint unlocks a Responses API, not OpenAI's image or audio
  // products, so those must resolve to the GemiX baselines.
  const chatgpt = getProviderProfile('chatgpt');
  assert.equal(backendFor(chatgpt, FEATURE.GENERATE_IMAGE), 'cloudflare-flux');
  assert.equal(backendFor(chatgpt, FEATURE.STT), 'cloudflare-whisper');
  assert.equal(isFeatureAvailable(chatgpt, FEATURE.GENERATE_VIDEO), false);
});

test('the search and workspace features stay GemiX-owned on every profile', () => {
  for (const id of ['xai', 'chatgpt']) {
    const profile = getProviderProfile(id);
    assert.equal(backendFor(profile, FEATURE.SEARCH_WEB), 'gemix-web');
    assert.equal(backendFor(profile, FEATURE.SEARCH_IMAGE), 'gemix-image-search');
    assert.equal(backendFor(profile, FEATURE.SHELL), 'gemix');
    assert.equal(backendFor(profile, FEATURE.MUSIC_GENERATION), 'openrouter-lyria');
    assert.equal(backendFor(profile, FEATURE.TTS), 'gemix-tts');
  }
});

// -- backend selection --------------------------------------------------------

test('the declared backend follows the binding, and disappears with the credentials', () => {
  withDeployment({ provider: 'xai', cloudflare: true }, () => {
    assert.equal(declaredImageBackend(), BACKEND.XAI);
  });
  withDeployment({ provider: 'chatgpt', cloudflare: true }, () => {
    assert.equal(declaredImageBackend(), BACKEND.CLOUDFLARE);
  });
  // A backend with no credentials is not offered at all.
  withDeployment({ provider: 'chatgpt', cloudflare: false }, () => {
    assert.equal(declaredImageBackend(), null);
  });
});

test('a cooled-down primary hands over to the fallback, and comes back after', () => {
  // Pinned to a deployment with a real chain, so this never silently no-ops on
  // a machine that happens to have no Cloudflare credentials.
  withDeployment({ provider: 'xai', cloudflare: true }, () => {
    const before = resolveImageBackends();
    assert.equal(before.primary, BACKEND.XAI);
    assert.equal(before.fallback, BACKEND.CLOUDFLARE);

    startCooldown(BACKEND.XAI);
    const during = resolveImageBackends();
    assert.equal(during.primary, BACKEND.CLOUDFLARE, 'the cooled backend is skipped');
    assert.equal(during.fallback, null, 'nothing left behind the last resort');

    _resetCooldownsForTests();
    assert.equal(resolveImageBackends().primary, BACKEND.XAI);
  });
});

// -- fallback policy ---------------------------------------------------------

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

test('the two kinds of 429 are told apart by what Cloudflare says', () => {
  // Retiring an account for the day on a burst limit would throw away a full
  // allowance, so only the wording about the allowance itself counts.
  assert.equal(
    classifyFailure(429, 'You have used up your daily free allocation of 10,000 neurons, '
      + 'please upgrade to the Workers Paid plan'),
    CF_ERROR.BUDGET
  );
  assert.equal(classifyFailure(429, 'Capacity temporarily exceeded'), CF_ERROR.RATE_LIMIT);
  assert.equal(classifyFailure(429, '3040: rate limited'), CF_ERROR.RATE_LIMIT);
});

test('an exhausted pool and a burst limit are not the same outage', () => {
  // Both send the request elsewhere and cool the backend down, but only the
  // first is written into the ring, so the wording has to stay distinguishable.
  assert.deepEqual(failurePlan(CF_ERROR.BUDGET), failurePlan(CF_ERROR.RATE_LIMIT));
  assert.match(EXHAUSTED_POOL_ERROR, /00:00 UTC/);
});

// -- FLUX sizes ---------------------------------------------------------------

test('a FLUX size resolves to real pixels, and an unknown one to the default', () => {
  assert.deepEqual(resolveFluxSize('landscape'), FLUX_SIZES.landscape);
  assert.deepEqual(resolveFluxSize('LANDSCAPE'), FLUX_SIZES.landscape);
  assert.deepEqual(resolveFluxSize('16:9'), FLUX_SIZES[FLUX_DEFAULT_SIZE], 'a ratio is not a FLUX size');
  assert.deepEqual(resolveFluxSize(undefined), FLUX_SIZES[FLUX_DEFAULT_SIZE]);
});

test('xAI text-to-image ratios map onto the closest FLUX presets', () => {
  for (const [ratio, size] of Object.entries(XAI_ASPECT_TO_FLUX_SIZE)) {
    assert.equal(fluxSizeForAspectRatio(ratio), size, ratio);
  }
  assert.equal(fluxSizeForAspectRatio(undefined), FLUX_DEFAULT_SIZE);
});

test('only text-to-image is a semantically valid xAI to FLUX fallback', () => {
  assert.equal(canUseImageFallback(BACKEND.XAI, BACKEND.CLOUDFLARE, 0), true);
  assert.equal(canUseImageFallback(BACKEND.XAI, BACKEND.CLOUDFLARE, 1), false);
  assert.equal(canUseImageFallback(BACKEND.XAI, BACKEND.CLOUDFLARE, 3), false);
});

test('an xAI reference edit never calls FLUX when xAI is cooling down', async () => {
  const calls = [];
  const result = await _runImageChain({
    primary: BACKEND.CLOUDFLARE,
    fallback: null,
    contractBackend: BACKEND.XAI,
    prompt: 'edit this image',
    refList: ['https://example.test/reference.png'],
    aspect: null,
    size: '',
    attemptBackend: async (backend) => {
      calls.push(backend);
      return { ok: true };
    }
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [], 'FLUX must not consume a request for an xAI edit');
  assert.match(result.error, /FLUX was not attempted.*cannot preserve/i);
});

test('an xAI reference edit never falls back to FLUX after an xAI failure', async () => {
  const calls = [];
  const result = await _runImageChain({
    primary: BACKEND.XAI,
    fallback: BACKEND.CLOUDFLARE,
    contractBackend: BACKEND.XAI,
    prompt: 'compose these images',
    refList: ['workspace/one.png', 'workspace/two.png'],
    aspect: null,
    size: '',
    attemptBackend: async (backend) => {
      calls.push(backend);
      return { ok: false, code: CF_ERROR.RATE_LIMIT, error: 'xAI rate limited' };
    }
  });

  assert.deepEqual(calls, [BACKEND.XAI]);
  assert.equal(result.ok, false);
  assert.match(result.error, /FLUX was not attempted.*cannot preserve/i);
});

test('xAI text-to-image may fall back to FLUX with its aspect translated', async () => {
  const calls = [];
  const result = await _runImageChain({
    primary: BACKEND.XAI,
    fallback: BACKEND.CLOUDFLARE,
    contractBackend: BACKEND.XAI,
    prompt: 'a wide mountain panorama',
    refList: [],
    aspect: '16:9',
    size: '',
    attemptBackend: async (backend, request) => {
      calls.push({ backend, size: request.size });
      if (backend === BACKEND.XAI) {
        return { ok: false, code: CF_ERROR.RATE_LIMIT, error: 'xAI rate limited' };
      }
      return { ok: true, buffer: Buffer.from('image'), ext: 'jpg', refCount: 0 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.backend, BACKEND.CLOUDFLARE);
  assert.deepEqual(calls, [
    { backend: BACKEND.XAI, size: 'landscape' },
    { backend: BACKEND.CLOUDFLARE, size: 'landscape' }
  ]);
});

test('FLUX takes exactly one reference, which is what the schema must say', () => {
  assert.equal(FLUX_MAX_REFERENCES, 1);
  const tools = withDeployment({ provider: 'chatgpt', cloudflare: true },
    () => getToolsForUser({ ...whatsappCtx, isActiveMember: true, isAdmin: false }));
  const schema = tools.find(tool => nameOf(tool) === 'generate_image').function.parameters;
  assert.equal(schema.properties.reference_images.maxItems, FLUX_MAX_REFERENCES);
});

// -- account rotation --------------------------------------------------------

const idsOf = (accounts) => accounts.map(account => account.accountId);

test('the pool is offered in .env order, with the ids and tokens paired', () => {
  const accounts = usableAccounts();
  assert.deepEqual(idsOf(accounts), ['cf-account-1', 'cf-account-2']);
  assert.deepEqual(accounts.map(a => a.apiToken), ['cf-token-1', 'cf-token-2']);
});

test('the account that last served a call is offered first after a restart', async () => {
  const [, second] = usableAccounts();
  await markAccountWorking(second.fingerprint);
  assert.deepEqual(
    idsOf(usableAccounts()),
    ['cf-account-2', 'cf-account-1'],
    'the working account leads, and the rest stay available behind it'
  );
});

test('an account Cloudflare has cut off drops out of the pool for the day', async () => {
  const [first] = usableAccounts();
  await markAccountExhausted(first.fingerprint);
  assert.deepEqual(idsOf(usableAccounts()), ['cf-account-2']);

  const [second] = usableAccounts();
  await markAccountExhausted(second.fingerprint);
  assert.deepEqual(usableAccounts(), []);

  const today = new Date().toISOString().slice(0, 10);
  const state = JSON.parse(fs.readFileSync(CLOUDFLARE_STATE_FILE, 'utf-8'));
  assert.deepEqual(Object.values(state.exhausted), Array(ACCOUNT_POOL.length).fill(today));
});

test('an account spent on an earlier day is eligible again', async () => {
  const [spent] = usableAccounts();
  await markAccountExhausted(spent.fingerprint);
  fs.writeFileSync(CLOUDFLARE_STATE_FILE, JSON.stringify({
    active: null,
    exhausted: { [spent.fingerprint]: '2020-01-01' }
  }));
  assert.deepEqual(idsOf(usableAccounts()), ['cf-account-1', 'cf-account-2']);
});

test('an account added to .env later joins the pool without disturbing the others', async () => {
  const [first] = usableAccounts();
  await markAccountExhausted(first.fingerprint);

  envConfig.CLOUDFLARE_AI_ACCOUNTS = [
    { accountId: 'cf-account-0', apiToken: 'cf-token-0' },
    ...ACCOUNT_POOL
  ];
  // Fingerprints follow the credentials, not their position, so the account
  // already written down as spent stays spent.
  assert.deepEqual(idsOf(usableAccounts()), ['cf-account-0', 'cf-account-2']);
});

test('an empty pool reports itself unconfigured rather than half-configured', () => {
  envConfig.CLOUDFLARE_AI_ACCOUNTS = [];
  assert.equal(isCloudflareConfigured(), false);
  assert.deepEqual(usableAccounts(), []);
});

// -- what the model is actually offered -------------------------------------
//
// The registry is read at call time, not at import time, so a profile swap here
// is enough to see the tool list the other deployment would get.

/** Run `fn` with a provider profile and Cloudflare state of our choosing. */
function withDeployment({ provider, cloudflare }, fn) {
  const saved = {
    provider: envConfig.AI_PROVIDER,
    accounts: envConfig.CLOUDFLARE_AI_ACCOUNTS
  };
  envConfig.AI_PROVIDER = provider;
  envConfig.CLOUDFLARE_AI_ACCOUNTS = cloudflare
    ? [{ accountId: 'test-account', apiToken: 'test-token' }]
    : [];
  _resetActiveProfileForTests();
  try { return fn(); }
  finally {
    envConfig.AI_PROVIDER = saved.provider;
    envConfig.CLOUDFLARE_AI_ACCOUNTS = saved.accounts;
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
    () => getToolsForUser({ ...whatsappCtx, isActiveMember: true, isAdmin: false }));

  assert.ok(names(tools).includes('x_search'));
  assert.ok(names(tools).includes('generate_video'));
  assert.deepEqual(paramsOf(tools, 'generate_image'), ['prompt', 'reference_images', 'aspect_ratio']);
  const imageSchema = tools.find(tool => nameOf(tool) === 'generate_image').function.parameters;
  const videoSchema = tools.find(tool => nameOf(tool) === 'generate_video').function.parameters;
  assert.equal(imageSchema.properties.reference_images.maxItems, constants.MAX_REF_IMAGES_FOR_IMAGE);
  assert.equal(videoSchema.properties.reference_images.maxItems, constants.MAX_REF_IMAGES_FOR_VIDEO);
});

test('on a profile without them, the native tools are absent rather than broken', () => {
  const tools = withDeployment({ provider: 'chatgpt', cloudflare: true },
    () => getToolsForUser({ ...whatsappCtx, isActiveMember: true, isAdmin: false }));

  assert.equal(names(tools).includes('x_search'), false, 'X search is xAI-specific');
  assert.equal(names(tools).includes('generate_video'), false, 'no video backend, no tool');
  // FLUX takes a named size, not a ratio: offering aspect_ratio here would be a
  // parameter the backend silently drops.
  assert.deepEqual(paramsOf(tools, 'generate_image'), ['prompt', 'reference_images', 'size']);
});

test('with no image backend at all the tool is withheld, not left to fail', () => {
  const tools = withDeployment({ provider: 'chatgpt', cloudflare: false },
    () => getToolsForUser({ ...whatsappCtx, isActiveMember: true, isAdmin: false }));

  assert.equal(paramsOf(tools, 'generate_image'), null);
  assert.ok(names(tools).includes('generate_music'), 'music has its own backend and stays');
});

test('the GemiX-owned tools are on every profile', () => {
  for (const provider of ['xai', 'chatgpt']) {
    const tools = withDeployment({ provider, cloudflare: false },
      () => getToolsForUser({ ...whatsappCtx, isActiveMember: true, isAdmin: false }));
    for (const name of ['search_web', 'search_image', 'read_file', 'shell']) {
      assert.ok(names(tools).includes(name), `${name} missing on ${provider}`);
    }
    assert.equal(names(tools).includes('web_image_search'), false, 'unsupported image tool name must stay absent');
    assert.equal(names(tools).includes('search_images'), false, 'xAI hosted tool name must stay reserved');
  }
});
