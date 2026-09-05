import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  VOICE_AUDIO_EXTS,
  mediaFamilyFor
} from '../src/config/mediaTypes.js';
import { mediaKindFor } from '../src/attachments/ingress.js';
import { familyOf } from '../src/parsers/mediaParser.js';
import { collectInlineImageParts } from '../src/tools/workspace/readFile.js';

test('ingress, parsing and voice projection share one media registry', () => {
  for (const ext of AUDIO_EXTS) {
    assert.equal(mediaFamilyFor({ ext }), 'audio');
    assert.equal(mediaKindFor(`clip${ext}`), 'audio');
    assert.equal(familyOf(ext), 'audio');
    assert.equal(VOICE_AUDIO_EXTS.has(ext), true);
  }
  for (const ext of VIDEO_EXTS) {
    assert.equal(mediaKindFor(`clip${ext}`), 'video');
    assert.equal(familyOf(ext), 'video');
  }
  assert.equal(mediaKindFor('recording.bin', 'audio/amr'), 'audio');
  assert.equal(mediaKindFor('movie.bin', 'video/mp4'), 'video');
});

test('derived image MIME and labels stay paired after an earlier image is rejected', () => {
  const jpeg = Buffer.alloc(12);
  jpeg[0] = 0xFF;
  jpeg[1] = 0xD8;
  jpeg[2] = 0xFF;
  const seenMimes = [];
  const result = collectInlineImageParts([
    { buffer: Buffer.from('reject'), mime: 'image/png', label: 'first' },
    { buffer: jpeg, mime: 'image/png', label: 'second' }
  ], 'document', {
    toPart(buffer, mime) {
      seenMimes.push(mime);
      return buffer === jpeg ? { type: 'input_image', image_url: `data:${mime}` } : null;
    }
  });

  assert.deepEqual(seenMimes, ['image/png', 'image/jpeg']);
  assert.deepEqual(result.accepted.map(image => image.label), ['second']);
  assert.match(result.notes.join(' '), /Could not attach first/);
});
