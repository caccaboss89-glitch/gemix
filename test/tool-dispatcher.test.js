// test/tool-dispatcher.test.js
//
// Common dispatcher behavior stays independent from domain executors.

import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';
import { executeTool } from '../src/tools/index.js';

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

test('the dispatcher rejects a missing required argument before execution', async () => {
  const output = await call('write_file', { path: 'workspace/file.txt' });
  assert.equal(output.toolCallId, 'call-write_file');
  assert.match(JSON.parse(output.result).error, /Missing required argument "content"/);
});

test('the dispatcher normalizes whitespace around model-authored argument keys', async () => {
  const output = await call('write_file', {
    ' path ': 'workspace/file.txt',
    ' content ': 'text'
  });
  assert.match(JSON.parse(output.result).error, /Cannot resolve a workspace/);
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
    error: 'Tool "not_a_tool" not recognized.'
  });
});
