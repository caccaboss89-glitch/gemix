// test/tool-call-ledger.test.js
//
// The per-turn ledger is what stands between a truncated model stream and a
// second real-world side effect (a second email, a second Build run), so these
// tests pin the exact deduplication contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallLedger } from '../src/utils/toolCallExecution.js';

const call = (id, name = 'send_email') => ({ id, type: 'function', function: { name, arguments: '{}' } });

test('a repeated call id replays its result without running again', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  const executor = async () => {
    runs++;
    return { role: 'tool', tool_call_id: 'call_1', content: '{"success":true}' };
  };

  const first = await ledger.run(call('call_1'), executor);
  const warnings = [];
  const second = await ledger.run(call('call_1'), executor, (why) => warnings.push(why));

  assert.equal(runs, 1);
  assert.deepEqual(second, first);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /already completed this turn/);
  assert.equal(ledger.size, 1);
});

test('each replay is its own object, so per-round trimming stays local', async () => {
  const ledger = new ToolCallLedger();
  const executor = async () => ({
    role: 'tool',
    tool_call_id: 'call_1',
    content: [{ type: 'text', text: '{}' }, { type: 'input_image', image_url: 'https://example.invalid/a.png' }]
  });

  const first = await ledger.run(call('call_1'), executor);
  const second = await ledger.run(call('call_1'), executor);
  assert.notEqual(first, second);

  // The handler strips heavy previews by reassigning content, which must not
  // reach through to the other copy.
  first.content = first.content.filter(p => p.type === 'text');
  assert.equal(second.content.length, 2);
});

test('concurrent arrivals of one id share a single execution', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = async () => {
    runs++;
    await gate;
    return { role: 'tool', tool_call_id: 'call_1', content: 'done' };
  };

  const warnings = [];
  const both = Promise.all([
    ledger.run(call('call_1'), executor),
    ledger.run(call('call_1'), executor, (why) => warnings.push(why))
  ]);
  release();
  const [a, b] = await both;

  assert.equal(runs, 1);
  assert.equal(a.content, 'done');
  assert.deepEqual(b, a);
  assert.match(warnings[0], /already running this turn/);
});

test('identical name and arguments under different ids both run', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  const executor = async () => {
    runs++;
    return { role: 'tool', tool_call_id: `call_${runs}`, content: 'ok' };
  };

  await ledger.run(call('call_1'), executor);
  await ledger.run(call('call_2'), executor);

  // Two deliberate sends of the same message are legitimate; only the id dedupes.
  assert.equal(runs, 2);
  assert.equal(ledger.size, 2);
});

test('an id reused under a different tool name is reported and not re-run', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  const executor = async () => {
    runs++;
    return { role: 'tool', tool_call_id: 'call_1', content: 'ok' };
  };

  await ledger.run(call('call_1', 'send_email'), executor);
  const warnings = [];
  await ledger.run(call('call_1', 'build'), executor, (why) => warnings.push(why));

  assert.equal(runs, 1);
  assert.match(warnings[0], /as "send_email"/);
});

test('a call without an id is executed and never recorded', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  const executor = async () => {
    runs++;
    return { role: 'tool', content: 'ok' };
  };

  await ledger.run({ function: { name: 'build' } }, executor);
  await ledger.run({ function: { name: 'build' } }, executor);

  assert.equal(runs, 2);
  assert.equal(ledger.size, 0);
});

test('a failed call is not silently retried under the same id', async () => {
  const ledger = new ToolCallLedger();
  let runs = 0;
  const executor = async () => {
    runs++;
    throw new Error('tool exploded');
  };

  await assert.rejects(ledger.run(call('call_1'), executor), /tool exploded/);
  await assert.rejects(ledger.run(call('call_1'), executor), /tool exploded/);
  assert.equal(runs, 1);
  assert.equal(ledger.has('call_1'), true);
});
