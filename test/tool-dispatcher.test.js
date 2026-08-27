// test/tool-dispatcher.test.js
//
// Common dispatcher behavior stays independent from domain executors.

import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';
import { executeTool, normalizeToolResult } from '../src/tools/index.js';

const USER_CTX = { platform: constants.PLATFORM_DISCORD };
const TOOL_DEFS = getToolsForUser({
  isActiveMember: true,
  isAdmin: false,
  platform: constants.PLATFORM_DISCORD,
  isGroup: false
});

function call(name, args, userCtx = USER_CTX) {
  return executeTool({
    id: `call-${name}`,
    function: { name, arguments: JSON.stringify(args) }
  }, userCtx, {}, {}, TOOL_DEFS);
}

function callRaw(name, rawArguments, userCtx = USER_CTX) {
  return executeTool({
    id: `call-${name}`,
    function: { name, arguments: rawArguments }
  }, userCtx, {}, {}, TOOL_DEFS);
}

test('the dispatcher rejects a missing required argument before execution', async () => {
  const output = await call('write_file', { path: 'workspace/file.txt' });
  assert.equal(output.toolCallId, 'call-write_file');
  const result = JSON.parse(output.result);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Missing required argument "content"/);
});

test('the dispatcher normalizes whitespace around model-authored argument keys', async () => {
  const output = await call('write_file', {
    ' path ': 'workspace/file.txt',
    ' content ': 'text'
  });
  assert.match(JSON.parse(output.result).error, /Cannot resolve a workspace/);
});

test('the dispatcher rejects malformed and non-object arguments before execution', async () => {
  for (const [rawArguments, expected] of [
    ['{"query":', /not valid JSON/],
    ['[]', /must be a JSON object/],
    ['null', /must be a JSON object/]
  ]) {
    const output = await callRaw('search_web', rawArguments);
    const result = JSON.parse(output.result);
    assert.equal(result.status, 'failed');
    assert.match(result.error, expected);
  }
});

test('the dispatcher rejects keys that collide after whitespace normalization', async () => {
  const output = await callRaw('search_web', '{"query":"first"," query ":"second"}');
  const result = JSON.parse(output.result);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /duplicate keys/);
});

test('an expired turn blocks a registered executor before it starts', async () => {
  const output = await call('search_web', { query: 'must not run' }, {
    ...USER_CTX,
    turnBudget: { expired: true }
  });
  assert.match(JSON.parse(output.result).error, /ended before the tool could start/);
});

test('an unknown function name receives the common error envelope', async () => {
  const output = await call('not_a_tool', {});
  assert.deepEqual(JSON.parse(output.result), {
    success: false,
    status: 'failed',
    error: 'Tool "not_a_tool" not recognized.'
  });
});

test('the result boundary rejects primitive, contradictory and malformed multipart results', () => {
  for (const raw of [
    'plain text',
    { success: true, status: 'failed' },
    { success: false, status: 'ok' },
    [{ type: 'input_text', text: 'not json' }]
  ]) {
    const normalized = normalizeToolResult(raw, 'broken_tool');
    assert.equal(normalized.valid, false);
    assert.equal(normalized.value.success, false);
    assert.equal(normalized.value.status, 'failed');
    assert.match(normalized.value.error, /broken_tool/);
  }
});

test('the result boundary canonicalizes valid object and multipart envelopes', () => {
  assert.deepEqual(normalizeToolResult({ success: true, answer: 1 }, 'ok_tool'), {
    valid: true,
    value: { success: true, status: 'ok', answer: 1 }
  });

  const multipart = normalizeToolResult([
    { type: 'input_text', text: '{"success":true,"count":1}' },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
  ], 'image_tool');
  assert.equal(multipart.valid, true);
  assert.deepEqual(JSON.parse(multipart.value[0].text), {
    success: true,
    status: 'ok',
    count: 1
  });
  assert.equal(multipart.value.length, 2);
});
