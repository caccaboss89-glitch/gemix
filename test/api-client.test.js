import assert from 'node:assert/strict';
import test from 'node:test';

import { _redactInlineData } from '../src/ai/apiClient.js';

test('API request logs redact nested inline base64 without mutating the request', () => {
  const inline = 'data:image/png;base64,QUJDREVGRw==';
  const request = {
    prompt: 'keep me',
    input: [{ image_url: inline }],
    nested: { references: [inline, 'https://example.com/reference.png'] }
  };
  const redacted = _redactInlineData(request);

  assert.equal(request.input[0].image_url, inline);
  assert.equal(redacted.prompt, 'keep me');
  assert.match(redacted.input[0].image_url, /^data:image\/png;base64,<\d+ chars omitted>$/);
  assert.equal(redacted.nested.references[1], 'https://example.com/reference.png');
  assert.equal(JSON.stringify(redacted).includes('QUJDREVGRw=='), false);
});
