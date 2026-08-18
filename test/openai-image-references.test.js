import test from 'node:test';
import assert from 'node:assert/strict';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub } from './helpers/fetchStub.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const {
  MAX_OPENAI_REFERENCE_IMAGES,
  OPENAI_ASPECT_SIZES,
  openAiSizeForAspect,
  resolveOpenAiReferenceImages
} = await import('../src/utils/openaiImageReferences.js');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 4)
]);

function context() {
  return {
    userCtx: { platform: 'discord', chatId: 'openai-ref-test' },
    responseCtx: { attachments: [{ name: 'local.png', buffer: PNG, mimetype: 'image/png' }] }
  };
}

test('the five provider-facing aspect ratios map to valid GPT Image 2 dimensions', () => {
  assert.deepEqual(Object.keys(OPENAI_ASPECT_SIZES), ['1:1', '16:9', '9:16', '4:3', '3:4']);
  for (const [ratio, size] of Object.entries(OPENAI_ASPECT_SIZES)) {
    assert.equal(openAiSizeForAspect(ratio), size);
    const [width, height] = size.split('x').map(Number);
    assert.equal(width % 16, 0);
    assert.equal(height % 16, 0);
    assert.ok(width * height >= 655_360 && width * height <= 8_294_400);
    assert.ok(Math.max(width, height) / Math.min(width, height) <= 3);
  }
  assert.equal(openAiSizeForAspect(), null);
  assert.equal(openAiSizeForAspect('2:1'), null);
});

test('a buffered local reference becomes a validated data URL without a network call', async () => {
  const stub = installFetchStub(() => { throw new Error('network must not be used'); });
  const { userCtx, responseCtx } = context();
  try {
    const result = await resolveOpenAiReferenceImages(['local.png'], userCtx, responseCtx);
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.match(result.images[0].image_url, /^data:image\/png;base64,/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('a public HTTPS reference is downloaded, sniffed and encoded', async () => {
  const stub = installFetchStub(() => new Response(PNG, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) }
  }));
  const { userCtx, responseCtx } = context();
  try {
    const result = await resolveOpenAiReferenceImages(
      ['https://images.example.test/reference.png'],
      userCtx,
      responseCtx
    );
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('missing, invalid and excessive references fail before the image endpoint', async () => {
  const { userCtx, responseCtx } = context();
  assert.equal((await resolveOpenAiReferenceImages(['missing.png'], userCtx, responseCtx)).ok, false);
  assert.equal((await resolveOpenAiReferenceImages(['http://example.test/a.png'], userCtx, responseCtx)).ok, false);
  const tooMany = Array.from({ length: MAX_OPENAI_REFERENCE_IMAGES + 1 }, () => 'local.png');
  const result = await resolveOpenAiReferenceImages(tooMany, userCtx, responseCtx);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Max allowed: 16/);
});
