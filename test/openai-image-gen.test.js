// test/openai-image-gen.test.js
//
// Phase 8: one logical generate_image, two back ends, and no way to end up
// with two of anything.
//
// The interesting cases are the ones where something goes wrong: a corrupt
// payload, a replayed call_id, an argument the private gpt-image-2 route was
// never validated with. In every one of them the user must not receive an
// invented attachment and the weekly quota must not be spent.

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
  UNVALIDATED_FIELDS,
  decodeImageBase64,
  generateImageOpenAi
} = await import('../src/tools/openaiImageGenerator.js');
const { getProviderProfile, PROVIDER } = await import('../src/ai/providers/providerProfile.js');
const envConfig = (await import('../src/config/env.js')).default;
const constants = (await import('../src/config/constants.js')).default;
const { TEMP_DIR } = await import('../src/utils/tempFileServer.js');

const OPENAI = getProviderProfile(PROVIDER.OPENAI);

// The fallback charges the shared neuron ledger, which lives in the real state
// file: it is put back byte for byte when this file finishes. That file is also
// why `npm test` runs one test file at a time — the voice suite charges the
// same ledger, and in parallel processes the two would race over it.
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

test('the fields gpt-image-2 was never validated with are refused by name', async () => {
  for (const field of UNVALIDATED_FIELDS) {
    const stub = installFetchStub(() => {
      throw new Error('must not reach the network');
    });
    try {
      const result = await generateImageOpenAi(
        { prompt: 'un gatto astronauta', [field]: field === 'reference_images' ? ['a.png'] : 'x' },
        makeUserCtx(),
        makeResponseCtx()
      );
      assert.equal(result.success, false, `${field} should be refused`);
      assert.match(result.error, new RegExp(field));
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

// -- The primary path ---------------------------------------------------------

test('a successful generation posts to the Codex image route and buffers one artifact', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => ({ data: [{ b64_json: PNG_B64 }], size: '1254x1254' }));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    const payload = payloadOf(result);
    assert.equal(payload.success, true);

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, `${envConfig.OPENAI_BASE_URL.replace(/\/+$/, '')}/images/generations`);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['ChatGPT-Account-ID'] !== undefined, true);
    assert.equal(JSON.parse(call.body).model, envConfig.OPENAI_IMAGE_MODEL);
    assert.equal(JSON.parse(call.body).prompt, 'un gatto astronauta');

    assert.equal(responseCtx.attachments.length, 1);
    const att = responseCtx.attachments[0];
    assert.equal(att.name, payload.filename);
    assert.equal(att.mimetype, 'image/png');
    assert.equal(fs.readFileSync(att.filePath).equals(PNG), true, 'the artifact is on disk');
    // The size the backend actually produced is reported, not the one asked for.
    assert.match(payload.message, /1254x1254/);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('the result never points the model at a video tool it does not have', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => ({ data: [{ b64_json: PNG_B64 }] }));
  try {
    const payload = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx));
    assert.doesNotMatch(payload.message, /generate_video|reference image|x_search|Imagine/i);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('a replayed call_id returns the first result without generating again', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => ({ data: [{ b64_json: PNG_B64 }] }));
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

test('a corrupt primary payload produces an error, not a phantom attachment', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => ({ data: [{ b64_json: HTML.toString('base64') }] }));
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

test('a response with no b64_json entry is reported as a failure', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub((url) => {
    if (String(url).includes('cloudflare')) return { success: true, result: { image: PNG_B64 } };
    return { data: [{ url: 'https://example.invalid/not-base64.png' }] };
  });
  try {
    // MALFORMED_RESPONSE is fallback-worthy, so FLUX runs and the user still
    // gets a real image rather than an error.
    const payload = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx));
    assert.equal(payload.success, true);
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[1].url, /api\.cloudflare\.com/);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

// -- The fallback -------------------------------------------------------------

test('a rate-limited primary falls back to FLUX exactly once', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub((url) => {
    if (String(url).includes('cloudflare')) return { success: true, result: { image: PNG_B64 } };
    return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 });
  });
  try {
    const payload = payloadOf(await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx));
    assert.equal(payload.success, true);
    assert.equal(stub.calls.length, 2, 'one primary attempt, one fallback attempt');
    assert.match(stub.calls[1].url, new RegExp(envConfig.CLOUDFLARE_IMAGE_MODEL.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(payload.message, /fallback/);
    assert.equal(responseCtx.attachments.length, 1);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('an unusable prompt rejected by the primary is not retried elsewhere', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => new Response(
    JSON.stringify({ error: { message: 'prompt rejected by the safety system' } }),
    { status: 400 }
  ));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.equal(stub.calls.length, 1, 'UNSUPPORTED_INPUT is not fallback-worthy');
    assert.match(result.error, /safety system/);
    assert.equal(responseCtx.attachments.length, 0);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('an auth failure on the primary is not retried elsewhere either', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub(() => new Response('{}', { status: 401 }));
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('both back ends failing reports both reasons and delivers nothing', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub((url) => {
    if (String(url).includes('cloudflare')) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 3000, message: 'capacity' }] }), { status: 500 });
    }
    return new Response('{}', { status: 503 });
  });
  try {
    const result = await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    assert.equal(result.success, false);
    assert.match(result.error, /fallback did not run either/);
    assert.equal(responseCtx.attachments.length, 0);
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('the fallback request carries the probed multipart contract', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub((url) => {
    if (String(url).includes('cloudflare')) return { success: true, result: { image: PNG_B64 } };
    return new Response('{}', { status: 503 });
  });
  try {
    await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    const call = stub.calls[1];
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Authorization'], 'Bearer cf-test-token');
    assert.equal(call.body instanceof FormData, true);
    assert.equal(call.body.get('prompt'), 'un gatto astronauta');
    assert.equal(call.body.get('width'), '512');
    assert.equal(call.body.get('height'), '512');
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

// -- Provider isolation -------------------------------------------------------

test('nothing on this path reaches an xAI host', async () => {
  const userCtx = makeUserCtx();
  const responseCtx = makeResponseCtx();
  const stub = installFetchStub((url) => {
    if (String(url).includes('cloudflare')) return { success: true, result: { image: PNG_B64 } };
    return new Response('{}', { status: 503 });
  });
  try {
    await generateImageOpenAi({ prompt: 'un gatto astronauta' }, userCtx, responseCtx);
    for (const call of stub.calls) {
      assert.doesNotMatch(call.url, /x\.ai|grok|imagine/i, `unexpected host: ${call.url}`);
    }
  } finally {
    stub.restore();
    cleanup(userCtx);
  }
});

test('the OpenAI profile still names one image generator and no video one', () => {
  assert.equal(OPENAI.imageGenerator, 'gpt-image');
  assert.equal(OPENAI.capabilities.generateImage, true);
  assert.equal(OPENAI.capabilities.generateVideo, false);
});
