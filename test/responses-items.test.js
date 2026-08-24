// test/responses-items.test.js
//
// The internal conversation is Responses-native end to end: one
// representation, built where the content is produced, sanitized once at the
// wire and never translated in between.
//
// What matters here is that the shapes the loop appends survive
// buildResponsesInput unchanged, and that a tool handing the model files keeps
// every label next to the file it names.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assistantTextItem,
  inputParts,
  pruneSeenToolMedia,
  systemItem,
  toolResultItems,
  userItem
} from '../src/ai/responsesItems.js';
import { buildResponsesInput } from '../src/ai/transport/responsesProtocol.js';
import {
  PER_ROUND_TOOL_LIMITS,
  partitionHandlerToolCalls,
  perRoundCappedDuplicateIds
} from '../src/utils/toolCallExecution.js';

const IMG = { type: 'input_image', image_url: 'data:image/png;base64,AA==' };

// -- role items ---------------------------------------------------------------

test('a string becomes one text part, and nothing becomes nothing', () => {
  assert.deepEqual(inputParts('hi'), [{ type: 'input_text', text: 'hi' }]);
  assert.deepEqual(inputParts(''), []);
  assert.equal(userItem(''), null, 'an empty turn is not an item');
  assert.equal(userItem([]), null);
});

test('a part list passes through as itself', () => {
  const parts = [{ type: 'input_text', text: 'look' }, IMG];
  assert.deepEqual(userItem(parts).content, parts);
});

test('the system prefix is a role item, never a typed one', () => {
  const item = systemItem('rules');
  assert.equal(item.role, 'system');
  assert.equal(item.type, undefined, 'a typed system item is not a Responses shape');
});

test('an assistant turn from history is a message item with output_text', () => {
  assert.deepEqual(assistantTextItem('said this'), {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'said this' }]
  });
});

// -- tool results -------------------------------------------------------------

test('a plain tool result is one function_call_output', () => {
  assert.deepEqual(toolResultItems('c1', '{"success":true}'), [
    { type: 'function_call_output', call_id: 'c1', output: '{"success":true}' }
  ]);
});

test('an object result is serialized rather than passed as an object', () => {
  const [item] = toolResultItems('c1', { success: true });
  assert.equal(item.output, '{"success":true}');
});

test('a tool that attaches files splits envelope from labelled parts', () => {
  const items = toolResultItems('c1', [
    { type: 'input_text', text: '{"success":true,"count":1}' },
    { type: 'input_text', text: '[search_image IMAGE_0]' },
    IMG
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'function_call_output');
  assert.equal(items[0].output, '{"success":true,"count":1}', 'only the envelope is the output');
  // The label has to travel with the image: folded into the output string it
  // would name nothing.
  assert.deepEqual(items[1].content, [
    { type: 'input_text', text: '[search_image IMAGE_0]' },
    IMG
  ]);
  assert.equal(items[1].role, 'user');
  assert.equal(items[1]._toolMedia, 'c1');
});

test('a result of parts with no leading envelope still answers the call', () => {
  const items = toolResultItems('c1', [IMG]);
  assert.equal(items[0].type, 'function_call_output');
  assert.ok(items[0].output.length > 0, 'a call always gets an output back');
  assert.equal(items[1].content.length, 1);
});

// -- media pruning ------------------------------------------------------------

test('an attached preview survives its own round and is dropped after', () => {
  const items = [
    systemItem('rules'),
    ...toolResultItems('c1', [{ type: 'input_text', text: 'env' }, { type: 'input_text', text: 'label' }, IMG])
  ];
  assert.equal(items.length, 3);

  assert.equal(pruneSeenToolMedia(items), 0, 'kept for the round it arrived on');
  assert.equal(items.length, 3);

  assert.equal(pruneSeenToolMedia(items), 1, 'dropped on the next round');
  assert.equal(items.length, 2);
  // The facts stay: only the pixels went.
  assert.equal(items[1].type, 'function_call_output');
  assert.equal(items[1].output, 'env');
});

test('a text-only companion is never pruned', () => {
  const items = toolResultItems('c1', [
    { type: 'input_text', text: 'env' },
    { type: 'input_text', text: 'more prose' }
  ]);
  pruneSeenToolMedia(items);
  pruneSeenToolMedia(items);
  assert.equal(items.length, 2, 'nothing heavy, nothing to drop');
});

// -- the wire boundary --------------------------------------------------------

test('every item the loop builds survives buildResponsesInput intact', () => {
  const input = buildResponsesInput([
    systemItem('rules'),
    userItem('question'),
    assistantTextItem('answer'),
    { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":"ls"}' },
    ...toolResultItems('c1', [{ type: 'input_text', text: 'env' }, IMG])
  ]);

  assert.deepEqual(input.map((i) => i.type || `role:${i.role}`), [
    'role:system',
    'role:user',
    'message',
    'function_call',
    'function_call_output',
    'role:user'
  ]);
});

test('internal bookkeeping never reaches the wire', () => {
  const item = systemItem('rules');
  item._staticPrefix = true;
  const [wire] = buildResponsesInput([item]);

  assert.equal(wire._staticPrefix, undefined);
  const [, media] = buildResponsesInput(toolResultItems('c1', [{ type: 'input_text', text: 'e' }, IMG]));
  assert.equal(media._toolMedia, undefined);
});

// -- tool-call ordering (same native shape) -----------------------------------
//
// The loop reads calls straight off `function_call` items, so these helpers see
// `{id, name, arguments}` — not a nested `function` object.

test('delivery tools run after everything else, in model order', () => {
  const calls = [
    { id: 'a', name: 'search_web', arguments: '{}' },
    { id: 'b', name: 'send_email', arguments: '{}' },
    { id: 'c', name: 'read_file', arguments: '{}' },
    { id: 'd', name: 'send_whatsapp_message', arguments: '{}' }
  ];
  const { standard, delivery } = partitionHandlerToolCalls(calls);

  assert.deepEqual(standard.map((t) => t.id), ['a', 'c']);
  // Sending happens once the round's research is done, never interleaved.
  assert.deepEqual(delivery.map((t) => t.id), ['b', 'd']);
});

test('a per-round cap blocks the extra calls, not the first ones', () => {
  const calls = [
    { id: 'a', name: 'read_music_stats', arguments: '{}' },
    { id: 'b', name: 'read_music_stats', arguments: '{}' },
    { id: 'c', name: 'search_web', arguments: '{}' },
    { id: 'd', name: 'search_web', arguments: '{}' }
  ];
  const blocked = perRoundCappedDuplicateIds(calls, PER_ROUND_TOOL_LIMITS);

  assert.deepEqual([...blocked], ['b'], 'the repeat is blocked, the first runs');
  // Research fan-out is the point of a round: those are deliberately uncapped.
  assert.equal(blocked.has('c'), false);
  assert.equal(blocked.has('d'), false);
});
