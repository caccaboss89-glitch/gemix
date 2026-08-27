// Direct xAI Imagine request contracts live behind one media boundary. These
// tests stay offline: they verify request shaping, failure taxonomy and the
// structural split without generating or downloading media.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  buildXaiImageRequest,
  buildXaiVideoRequest,
  classifyXaiFailure
} from '../src/media/xaiImagineClient.js';
import { sniffVideoType } from '../src/utils/videoType.js';

test('xAI image requests select generation or edit shapes from reference count', () => {
  assert.deepEqual(buildXaiImageRequest({
    model: 'image-model',
    prompt: 'a mountain',
    referenceImages: [],
    aspectRatio: '16:9'
  }), {
    endpointPath: '/images/generations',
    body: {
      model: 'image-model',
      prompt: 'a mountain',
      response_format: 'url',
      aspect_ratio: '16:9'
    }
  });

  assert.deepEqual(buildXaiImageRequest({
    model: 'image-model',
    prompt: 'edit this',
    referenceImages: ['data:image/png;base64,ONE']
  }), {
    endpointPath: '/images/edits',
    body: {
      model: 'image-model',
      prompt: 'edit this',
      response_format: 'url',
      image: { type: 'image_url', url: 'data:image/png;base64,ONE' }
    }
  });

  const multi = buildXaiImageRequest({
    model: 'image-model',
    prompt: 'compose these',
    referenceImages: ['https://example.test/one.png', 'data:image/png;base64,TWO']
  });
  assert.equal(multi.endpointPath, '/images/edits');
  assert.deepEqual(multi.body.images, [
    { type: 'image_url', url: 'https://example.test/one.png' },
    { type: 'image_url', url: 'data:image/png;base64,TWO' }
  ]);
  assert.equal(multi.body.aspect_ratio, undefined);
});

test('xAI video requests keep text, single-reference and multi-reference shapes distinct', () => {
  const base = {
    model: 'video-model',
    prompt: 'a short clip',
    aspectRatio: '9:16',
    duration: 8,
    resolution: '720p'
  };
  const textOnly = buildXaiVideoRequest({ ...base, referenceImages: [] });
  assert.equal(textOnly.endpointPath, '/videos/generations');
  assert.deepEqual(textOnly.body, {
    model: 'video-model',
    prompt: 'a short clip',
    duration: 8,
    resolution: '720p',
    aspect_ratio: '9:16'
  });
  const single = buildXaiVideoRequest({ ...base, referenceImages: ['one'] });
  assert.equal(single.endpointPath, '/videos/generations');
  assert.deepEqual(single.body.image, {
    type: 'image_url',
    url: 'one'
  });
  const multiple = buildXaiVideoRequest({ ...base, referenceImages: ['one', 'two'] });
  assert.equal(multiple.endpointPath, '/videos/generations');
  assert.deepEqual(multiple.body.reference_images, [
    { type: 'image_url', url: 'one' },
    { type: 'image_url', url: 'two' }
  ]);
});

test('xAI failures retain the fallback policy taxonomy', () => {
  assert.equal(classifyXaiFailure('prompt violates content policy'), 'CONTENT_POLICY');
  assert.equal(classifyXaiFailure('HTTP 429 too many requests'), 'RATE_LIMIT');
  assert.equal(classifyXaiFailure('HTTP 401 unauthorized'), 'AUTH');
  assert.equal(classifyXaiFailure('HTTP 503 upstream timeout'), 'TRANSIENT');
  assert.equal(classifyXaiFailure('response had no data'), 'MALFORMED');
});

test('generated video containers are identified from bytes rather than URL metadata', () => {
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom', 'ascii')]);
  const mov = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ', 'ascii')]);
  const webm = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffVideoType(mp4), { ext: 'mp4', mime: 'video/mp4' });
  assert.deepEqual(sniffVideoType(mov), { ext: 'mov', mime: 'video/quicktime' });
  assert.deepEqual(sniffVideoType(webm), { ext: 'webm', mime: 'video/webm' });
  assert.equal(sniffVideoType(Buffer.from('<html>not video</html>')), null);
});

test('the tool orchestrator has no direct xAI HTTP implementation left', () => {
  const source = fs.readFileSync(new URL('../src/tools/imagineGenerator.js', import.meta.url), 'utf-8');

  assert.match(source, /generateXaiImage/);
  assert.match(source, /generateXaiVideo/);
  assert.doesNotMatch(source, /callApiWithRetry|fetchXaiWithOAuthRetry|getXaiServiceAuth|downloadPublicFile/);
  assert.doesNotMatch(source, /\/v1\/(?:images|videos)|\/videos\/\$\{/);
});
