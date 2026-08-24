import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
