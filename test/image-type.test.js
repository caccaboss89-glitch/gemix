import assert from 'node:assert/strict';
import test from 'node:test';

import { sniffImageType } from '../src/utils/imageType.js';

test('image magic bytes override misleading file extensions and provider metadata', () => {
  const jpegNamedPng = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffImageType(jpegNamedPng), { ext: 'jpg', mime: 'image/jpeg' });

  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  assert.deepEqual(sniffImageType(png), { ext: 'png', mime: 'image/png' });
});

test('HTML and unknown bodies are not saved as generated images', () => {
  assert.equal(sniffImageType(Buffer.from('<html>error</html>')), null);
});
