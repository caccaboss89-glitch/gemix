// test/tool-log-summary.test.js
//
// Execution logs describe tool shape and size without persisting user content.

import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeToolCall, summarizeToolResult } from '../src/utils/toolLogSummary.js';

test('tool-call summaries expose keys and sizes, never argument values', () => {
  const secret = 'private file body that must never reach logs';
  const summary = summarizeToolCall({
    name: 'write_file',
    arguments: JSON.stringify({ path: 'workspace/private.txt', content: secret })
  });
  const rendered = JSON.stringify(summary);
  assert.equal(summary.tool, 'write_file');
  assert.deepEqual(summary.argumentKeys, ['content', 'path']);
  assert.ok(summary.argumentBytes > secret.length);
  assert.doesNotMatch(rendered, /private file body|private\.txt/);
});

test('tool-result summaries never copy text, paths, URLs, errors or base64', () => {
  const result = {
    success: false,
    error_code: 'FILE_UNAVAILABLE',
    error: 'workspace/private.txt contains a private explanation',
    content: 'data:image/png;base64,TOP_SECRET',
    url: 'https://private.example/file'
  };
  const summary = summarizeToolResult(result);
  const rendered = JSON.stringify(summary);
  assert.equal(summary.success, false);
  assert.equal(summary.error_code, undefined);
  assert.deepEqual(summary.keys, ['content', 'error', 'error_code', 'success', 'url']);
  assert.doesNotMatch(rendered, /TOP_SECRET|private\.txt|private\.example|private explanation/);
});

test('content-part arrays are reduced to type counts', () => {
  const summary = summarizeToolResult([
    { type: 'input_text', text: 'private transcript' },
    { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE' }
  ]);
  assert.deepEqual(summary.partTypes, { input_text: 1, input_image: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /private transcript|PRIVATE/);
});
