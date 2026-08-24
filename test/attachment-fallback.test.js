import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildFallbackAttachmentMessage } from '../src/utils/attachmentFallback.js';

test('link fallback materializes an in-memory attachment exactly once', () => {
  const attachment = {
    name: 'buffer.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('payload')
  };

  try {
    const result = buildFallbackAttachmentMessage([attachment]);

    assert.equal(result.fallbackLinks.length, 1);
    assert.equal(result.fallbackLinks[0].size, 7);
    assert.match(result.message, /buffer\.txt/);
    assert.equal(typeof attachment.filePath, 'string');
    assert.equal(fs.readFileSync(attachment.filePath, 'utf8'), 'payload');
  } finally {
    if (attachment.filePath) fs.rmSync(attachment.filePath, { force: true });
  }
});
