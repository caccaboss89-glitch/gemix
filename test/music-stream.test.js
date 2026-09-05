import assert from 'node:assert/strict';
import test from 'node:test';
import {
  callLyriaStreaming,
  createMusicAudioAccumulator,
  decodeMusicAudio
} from '../src/tools/musicCreator.js';

test('music stream accumulation is bounded before concatenation', () => {
  const audio = createMusicAudioAccumulator(3);
  audio.add('AAAA');
  assert.throws(() => audio.add('A'), /exceeds/);
});

test('music base64 decoding rejects malformed and oversized payloads', () => {
  assert.deepEqual(decodeMusicAudio('data:audio/mp3;base64,YQ==', 1), Buffer.from('a'));
  assert.throws(() => decodeMusicAudio('not base64!', 20), /invalid or oversized/);
  assert.throws(() => decodeMusicAudio('YWI=', 1), /invalid or oversized|exceeds/);
});

test('music streaming accepts no-space and multiline SSE data fields', async () => {
  const savedFetch = globalThis.fetch;
  let released = false;
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(
    'data: {"choices":[\n'
    + 'data:{"delta":{"audio":{"data":"YQ=="}}}\n'
    + 'data: ]}\n\n'
  )];
  try {
    globalThis.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              return chunks.length > 0 ? { done: false, value: chunks.shift() } : { done: true };
            },
            async cancel() {},
            releaseLock() { released = true; }
          };
        }
      }
    });
    const result = await callLyriaStreaming('test-model', 'https://api.example.invalid', {}, 'key');
    assert.equal(result.audio.data, 'YQ==');
    assert.equal(released, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('music streaming cancels and releases its reader when consumption fails', async () => {
  const savedFetch = globalThis.fetch;
  let cancelled = false;
  let released = false;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      body: {
        getReader() {
          return {
            async read() { throw new Error('reader failed'); },
            async cancel() { cancelled = true; },
            releaseLock() { released = true; }
          };
        }
      }
    });
    await assert.rejects(
      callLyriaStreaming('test-model', 'https://api.example.invalid', {}, 'key'),
      /reader failed/
    );
    assert.equal(cancelled, true);
    assert.equal(released, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
