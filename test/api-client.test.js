import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _redactInlineData } from '../src/ai/apiClient.js';
import { ApiLogStore, LOG_MAX_AGE_MS } from '../src/ai/apiLogs.js';

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
  assert.match(
    redacted.input[0].image_url,
    /^data:image\/png;base64,<base64 omitted: \d+ chars, sha256=[a-f0-9]{64}>$/
  );
  assert.equal(redacted.nested.references[1], 'https://example.com/reference.png');
  assert.equal(JSON.stringify(redacted).includes('QUJDREVGRw=='), false);
});

test('API logs retain complete safe fields and remove only files older than 30 days', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-api-logs-'));
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  try {
    const store = new ApiLogStore({ logDir, now: () => now });
    const freshPath = store.write('request', 'requestBody', 'model', 'https://api.test/responses', {
      input: [{ role: 'user', content: 'complete text' }],
      access_token: 'do-not-store'
    }, { apiLogId: 'pair-1' });
    const entry = JSON.parse(fs.readFileSync(freshPath, 'utf8'));
    assert.equal(entry.requestBody.input[0].content, 'complete text');
    assert.equal(entry.requestBody.access_token, '<redacted>');
    assert.equal(entry.apiLogId, 'pair-1');

    const oldPath = path.join(logDir, 'api-response-old.json');
    fs.writeFileSync(oldPath, '{}');
    const oldTime = new Date(now - LOG_MAX_AGE_MS - 1);
    fs.utimesSync(oldPath, oldTime, oldTime);
    assert.equal(store.cleanupOldLogs(), 1);
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(freshPath), true);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
