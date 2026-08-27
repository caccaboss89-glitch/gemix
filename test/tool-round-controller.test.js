// The model authors one ordered batch. Read-only fan-out may overlap, but an
// effect is a hard barrier: moving a send or mutation changes the request the
// model made even if the eventual transcript is sorted back into call order.

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeToolRound } from '../src/ai/toolRoundController.js';
import { TOOL_READ_CONCURRENCY } from '../src/utils/toolCallExecution.js';

function toolDef(name) {
  return { type: 'function', function: { name } };
}

function stateFor(calls) {
  return {
    roundTools: [...new Set(calls.map(call => call.name))].map(toolDef),
    userCtx: {},
    responseCtx: {},
    deliveryCtx: {},
    platformCtx: {}
  };
}

function outputsByCall(items) {
  return items
    .filter(item => item.type === 'function_call_output')
    .map(item => ({ id: item.call_id, body: JSON.parse(item.output) }));
}

test('effects stay at their original barriers while adjacent reads overlap', async () => {
  const calls = [
    { id: 'read-a', name: 'search_web', arguments: '{}' },
    { id: 'read-b', name: 'read_page', arguments: '{}' },
    { id: 'write', name: 'write_file', arguments: '{}' },
    { id: 'read-c', name: 'read_file', arguments: '{}' },
    { id: 'send', name: 'send_email', arguments: '{}' },
    { id: 'read-d', name: 'read_my_tasks', arguments: '{}' }
  ];
  const events = [];
  let activeReads = 0;
  let maxActiveReads = 0;

  const fakeExecute = async toolCall => {
    const { id, function: fn } = toolCall;
    const isRead = fn.name.startsWith('read_') || fn.name === 'search_web';
    events.push(`start:${id}`);
    if (isRead) {
      activeReads++;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise(resolve => setTimeout(resolve, 15));
      activeReads--;
    }
    events.push(`end:${id}`);
    return { toolCallId: id, result: { success: true, id } };
  };

  const result = await executeToolRound(calls, stateFor(calls), { executeTool: fakeExecute });

  assert.equal(maxActiveReads, 2, 'the first consecutive reads overlap');
  assert.ok(events.indexOf('start:write') > events.indexOf('end:read-a'));
  assert.ok(events.indexOf('start:write') > events.indexOf('end:read-b'));
  assert.ok(events.indexOf('start:read-c') > events.indexOf('end:write'));
  assert.ok(events.indexOf('start:send') > events.indexOf('end:read-c'));
  assert.ok(events.indexOf('start:read-d') > events.indexOf('end:send'));
  assert.deepEqual(outputsByCall(result).map(output => output.id), calls.map(call => call.id));
});

test('one read-only phase has bounded concurrency and ordered outputs', async () => {
  const calls = Array.from({ length: TOOL_READ_CONCURRENCY + 3 }, (_, index) => ({
    id: `read-${index}`,
    name: index % 2 ? 'read_page' : 'search_web',
    arguments: '{}'
  }));
  let active = 0;
  let maxActive = 0;

  const fakeExecute = async toolCall => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { toolCallId: toolCall.id, result: { success: true, id: toolCall.id } };
  };

  const result = await executeToolRound(calls, stateFor(calls), { executeTool: fakeExecute });

  assert.equal(maxActive, TOOL_READ_CONCURRENCY);
  assert.deepEqual(outputsByCall(result).map(output => output.id), calls.map(call => call.id));
});

test('one failed call is isolated and later effects still run', async () => {
  const calls = [
    { id: 'good-read', name: 'search_web', arguments: '{}' },
    { id: 'bad-read', name: 'read_page', arguments: '{}' },
    { id: 'send', name: 'send_email', arguments: '{}' }
  ];
  const executed = [];
  const fakeExecute = async toolCall => {
    executed.push(toolCall.id);
    if (toolCall.id === 'bad-read') throw new Error('synthetic failure');
    return { toolCallId: toolCall.id, result: { success: true } };
  };

  const result = outputsByCall(
    await executeToolRound(calls, stateFor(calls), { executeTool: fakeExecute })
  );

  assert.deepEqual(executed, ['good-read', 'bad-read', 'send']);
  assert.equal(result[0].body.success, true);
  assert.equal(result[1].body.success, false);
  assert.match(result[1].body.error, /synthetic failure/);
  assert.equal(result[2].body.success, true);
});

test('per-round duplicate caps span phases separated by effects', async () => {
  const calls = [
    { id: 'stats-1', name: 'read_music_stats', arguments: '{}' },
    { id: 'write', name: 'write_file', arguments: '{}' },
    { id: 'stats-2', name: 'read_music_stats', arguments: '{}' }
  ];
  const executed = [];
  const fakeExecute = async toolCall => {
    executed.push(toolCall.id);
    return { toolCallId: toolCall.id, result: { success: true } };
  };

  const result = outputsByCall(
    await executeToolRound(calls, stateFor(calls), { executeTool: fakeExecute })
  );

  assert.deepEqual(executed, ['stats-1', 'write']);
  assert.equal(result[0].body.success, true);
  assert.equal(result[1].body.success, true);
  assert.equal(result[2].body.success, false);
  assert.match(result[2].body.error, /once per round/);
});
