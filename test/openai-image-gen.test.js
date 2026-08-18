// test/openai-image-gen.test.js
//
// generate_image on the OpenAI profile: one back end, Cloudflare Workers AI.
//
// The endpoint was probed with an input image under every plausible field name
// and ignored all of them, so this profile is text-to-image only. The
// interesting cases are the ones where something goes wrong — a corrupt
// payload, a replayed call_id, an argument this generator cannot honour. In
// every one of them the user must not receive an invented attachment and the
// weekly quota must not be spent.
//
// This file charges the shared Cloudflare neuron ledger, which lives in the
// real state file, so the suite runs with --test-concurrency=1 and the state is
// put back byte for byte at the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub } from './helpers/fetchStub.js';

const AUTH_FILE = writeAuthFile();
seedEnv({
  XAI_AUTH_FILE: AUTH_FILE,
  OPENAI_AUTH_FILE: AUTH_FILE,
  CLOUDFLARE_AI_ACCOUNT_ID: 'acct-test',
  CLOUDFLARE_AI_API_TOKEN: 'cf-test-token'
});

const {
  MAX_IMAGE_BYTES,
  ASPECT_SIZES,
  UNSUPPORTED_FIELDS,
  decodeImageBase64,
  generateImageOpenAi
} = await import('../src/tools/openaiImageGenerator.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const envConfig = (await import('../src/config/env.js')).default;
const constants = (await import('../src/config/constants.js')).default;
const { TEMP_DIR } = await import('../src/utils/tempFileServer.js');
const neurons = await import('../src/utils/cloudflareNeurons.js');
const { update: updateState } = await import('../src/utils/systemState.js');
const { clearMediaUsage, formatQuotaCounts } = await import('../src/utils/mediaUsageLimits.js');

const OPENAI = getProviderProfile(PROVIDER.OPENAI);

const STATE_FILE = path.join(constants.DATA_DIR, 'systemState.json');
const STATE_BEFORE = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;

test.after(() => {
  if (STATE_BEFORE === null) fs.rmSync(STATE_FILE, { force: true });
  else fs.writeFileSync(STATE_FILE, STATE_BEFORE);
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 7)
]);
const PNG_B64 = PNG.toString('base64');
const HTML = Buffer.from('<!doctype html><html><body>error</body></html>');

/** The shape Cloudflare answers with on success. */
const cfOk = (b64 = PNG_B64) => ({ success: true, result: { image: b64 } });

/** A userCtx that resolves a storage id without touching a real chat. */
function makeUserCtx() {
  return {
    providerProfile: OPENAI,
    platform: 'discord',
    chatId: `gemix-test-imagegen-${Math.random().toString(36).slice(2, 10)}`,
    isAdmin: true,
    taskFileId: null
  };
}

function makeResponseCtx() {
  return { attachments: [], providerProfile: OPENAI };
}

/** Remove whatever a run wrote under the per-owner temp dir. */
function cleanup(userCtx) {
  const dir = path.join(TEMP_DIR, String(userCtx.chatId));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** The JSON payload a tool result carries, whether or not a preview came with it. */
function payloadOf(result) {
  if (Array.isArray(result)) return JSON.parse(result[0].text);
  return result;
}

async function resetNeuronLedger() {
  await updateState('cloudflareNeurons', () => ({
    period: neurons.periodKey(),
    used: 0,
    circuitOpen: false,
    calls: 0
  }));
}

// -- Bounded, strict base64 decode -------------------------------------------

test('a real PNG decodes with its own type', () => {
  const decoded = decodeImageBase64(PNG_B64);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.mime, 'image/png');
  assert.equal(decoded.ext, '.png');
  assert.equal(decoded.buffer.length, PNG.length);
});

test('empty, non-base64 and non-image bodies are all refused', () => {
  assert.equal(decodeImageBase64('').ok, false);
  assert.equal(decodeImageBase64(null).ok, false);
  assert.equal(decodeImageBase64('not base64 !!!').ok, false);
  assert.equal(decodeImageBase64(Buffer.alloc(0).toString('base64')).ok, false);
  const html = decodeImageBase64(HTML.toString('base64'));
  assert.equal(html.ok, false);
  assert.match(html.reason, /not a PNG, JPEG or WEBP/);
});

test('an oversized payload is refused before it is decoded', () => {
  // Long enough to exceed the cap by its length alone; never materialized.
  const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES / 3) * 4) + 8);
  const decoded = decodeImageBase64(huge);
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /exceeds the/);
});

// -- Argument contract --------------------------------------------------------

test('editing and reference arguments are refused by name, never downgraded', async () => {
  // The back end ignores an input image instead of rejecting it, so accepting
  // any of these would quietly return something unrelated to what was asked.
  for (const field of UNSUPPORTED_FIELDS) {
    const stub = installFetchStub(() => { throw new Error('must not reach the network'); });
    try {
      const result = await generateImageOpenAi(
        { prompt: 'un gatto astronauta', [field]: field === 'reference_images' ? ['a.png'] : 'x' },
        makeUserCtx(),
        makeResponseCtx()
      );
      assert.equal(result.success, false, `${field} should be refused`);
      assert.match(result.error, new RegExp(field));
      assert.match(result.error, /cannot edit an image or use one as reference/);
      assert.equal(stub.calls.length, 0, `${field} must not reach the network`);
    } finally {
      stub.restore();
    }
  }
});

test('a missing or too-short prompt never reaches the network', async () => {
  const stub = installFetchStub(() => { throw new Error('must not reach the network'); });
  try {
    assert.equal((await generateImageOpenAi({}, makeUserCtx(), makeResponseCtx())).success, false);
    assert.equal((await generateImageOpenAi({ prompt: 'x' }, makeUserCtx(), makeResponseCtx())).success, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('an aspect ratio outside the enum is refused instead of silently squared', async () => {
  const stub = installFetchStub(() => { throw new Error('must not reach the network'); });
  try {
    const result = await generateImageOpenAi(
      { prompt: 'un gatto astronauta', aspect_ratio: '21:9' }, makeUserCtx(), makeResponseCtx()
    );
    assert.equal(result.success, false);
    assert.match(result.error, /aspect_ratio/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('each aspect ratio asks for its own pixel size', async () => {
  // Width and height are the parameters this back end really honours, so the
  // ratio has to reach it as concrete pixels.
  for (const [ratio, [w, h]] of Object.entries(ASPECT_SIZES)) {
    await resetNeuronLedger();
    const userCtx = makeUserCtx();
    const stub = installFetchStub(() => cfOk());
    try {
      await generateImageOpenAi({ prompt: 'un gatto astronauta', aspect_ratio: ratio }, userCtx, makeResponseCtx());
      assert.equal(stub.calls[0].body.get('width'), String(w), `${ratio} width`);
      assert.equal(stub.calls[0].body.get('height'), String(h), `${ratio} height`);
    } finally {
      stub.restore();
      cleanup(userCtx);
    }
  }
});

// -- The generation path ------------------------------------------------------

test('a successful generation posts the probed multipart contract and buffers one artifact', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk());
  try {
    const payload = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx));
    assert.equal(payload.success, true);

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(
      call.url,
      `https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/${envConfig.CLOUDFLARE_IMAGE_MODEL}`
    );
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Authorization'], 'Bearer cf-test-token');
    // The endpoint takes multipart only — a JSON body is rejected outright.
    assert.equal(call.body instanceof FormData, true);
    assert.equal(call.body.get('prompt'), 'un gatto astronauta');
    assert.equal(call.body.get('width'), '1024');
    assert.equal(call.body.get('height'), '1024');

    assert.equal(responseCtx.attachments.length, 1);
    const att = responseCtx.attachments[0];
    assert.equal(att.name, payload.filename);
    assert.equal(att.mimetype, 'image/png');
    assert.equal(fs.readFileSync(att.filePath).equals(PNG), true, 'the artifact is on disk');
    assert.match(payload.message, /1024x1024/);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('the result never points the model at a capability this profile lacks', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk());
  try {
    const payload = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx));
    assert.doesNotMatch(payload.message, /generate_video|reference image|x_search|Imagine|Grok/i);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('a replayed call_id returns the first result without generating again', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk());
  try {
    const first = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx, 'call_1'));
    const second = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx, 'call_1'));
    assert.equal(second.filename, first.filename, 'same artifact');
    assert.equal(stub.calls.length, 1, 'only one generation');
    assert.equal(responseCtx.attachments.length, 1, 'only one delivery');
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('an HTML error page dressed as an image never becomes an attachment', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk(HTML.toString('base64')));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.match(result.error, /unusable result/);
    assert.equal(responseCtx.attachments.length, 0);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('a success response carrying no image is reported as a failure', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => ({ success: true, result: {} }));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.match(result.error, /no image/);
    assert.equal(responseCtx.attachments.length, 0);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

// -- Quota and the shared neuron ledger ---------------------------------------

test('an exhausted allowance returns the specific Italian image reset message', async () => {
  await resetNeuronLedger();
  await neurons.openQuotaCircuit();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk());
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.match(result.error, /limite giornaliero di generazione immagini/i);
    assert.match(result.error, /mezzanotte/i);
    assert.equal(stub.calls.length, 0, 'the breaker is checked before the network');
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('a back-end denial does not consume normal user image or song quota', async () => {
  await resetNeuronLedger();
  await neurons.openQuotaCircuit();
  const userCtx = makeUserCtx();
  userCtx.isAdmin = false;
  userCtx.taskFileId = `media-quota-${Math.random().toString(36).slice(2, 10)}`;
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => new Response('{}', { status: 503 }));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    const quotaLine = formatQuotaCounts(userCtx.taskFileId, ['image', 'song']);
    assert.match(quotaLine, /Immagini: 0\/5/);
    assert.match(quotaLine, /Canzoni: 0\/2/);
  } finally {
    stub.restore();
    await clearMediaUsage(userCtx.taskFileId);
    cleanup(userCtx);
  }
});

test('a quota response opens the shared breaker and hides its raw error', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 3036, message: 'neuron quota exceeded' }]
  }), { status: 429 }));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.match(result.error, /limite giornaliero di generazione immagini/i);
    assert.doesNotMatch(result.error, /3036|neuron quota exceeded/i);
    assert.equal(neurons.readNeuronLedger().circuitOpen, true);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('an ambiguous fetch failure stays charged for safe retries', async () => {
  // The request may well have reached Cloudflare and been billed, so the
  // pessimistic charge stands rather than refunding work that may have run.
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => { throw new TypeError('fetch failed'); });
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.equal(neurons.readNeuronLedger().used, neurons.neuronsForImage(1024, 1024));
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

// -- Provider isolation -------------------------------------------------------

test('nothing on this path reaches an xAI or ChatGPT host', async () => {
  await resetNeuronLedger();
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => cfOk());
  try {
    await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.ok(stub.calls.length > 0, 'nothing was requested, so this proves nothing');
    for (const call of stub.calls) {
      assert.match(call.url, /^https:\/\/api\.cloudflare\.com\//, `unexpected host: ${call.url}`);
      assert.doesNotMatch(call.url, /x\.ai|grok|imagine|chatgpt\.com/i, `unexpected host: ${call.url}`);
    }
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('the OpenAI profile names one image generator and no video one', () => {
  assert.equal(OPENAI.imageGenerator, 'cloudflare-flux');
  assert.equal(OPENAI.capabilities.generateImage, true);
  assert.equal(OPENAI.capabilities.generateVideo, false);
});
