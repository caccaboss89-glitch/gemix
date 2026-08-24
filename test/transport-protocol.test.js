// test/transport-protocol.test.js
//
// The pure Responses wire format: what reaches a provider, and what GemiX reads
// back. No network, no credentials — these are the shape guarantees every
// profile depends on.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_REPLAYABLE_ITEM_TYPES,
  buildResponsesBody,
  buildResponsesInput,
  pickAssistantText,
  readResponse,
  toolsToWire,
  wireItem,
  wirePart
} from '../src/ai/transport/responsesProtocol.js';

test('wirePart keeps only wire fields and drops internal bookkeeping', () => {
  assert.deepEqual(
    wirePart({ type: 'input_text', text: 'hello', _historyPath: 'history/a.txt' }),
    { type: 'input_text', text: 'hello' }
  );
  assert.deepEqual(
    wirePart({ type: 'input_image', image_url: 'https://x/i.png', _sourcePath: '/tmp/i.png' }),
    { type: 'input_image', image_url: 'https://x/i.png' }
  );
  assert.deepEqual(
    wirePart({ type: 'input_file', file_url: 'https://x/f.pdf' }),
    { type: 'input_file', file_url: 'https://x/f.pdf' }
  );
});

test('wirePart takes native parts only — there is no second content dialect', () => {
  assert.deepEqual(wirePart({ type: 'input_text', text: 'hi' }), { type: 'input_text', text: 'hi' });
  assert.deepEqual(
    wirePart({ type: 'input_image', image_url: 'https://x/i.png' }),
    { type: 'input_image', image_url: 'https://x/i.png' }
  );
  // Accepting chat-style parts would hide a producer emitting the wrong
  // protocol shape.
  assert.equal(wirePart({ type: 'text', text: 'hi' }), null);
  assert.equal(wirePart({ type: 'image_url', image_url: { url: 'https://x/i.png' } }), null);
});

test('wirePart rejects empty text, urlless media and an inline file without a filename', () => {
  assert.equal(wirePart({ type: 'input_text', text: '' }), null);
  assert.equal(wirePart({ type: 'input_image' }), null);
  assert.equal(wirePart({ type: 'input_file', file_data: 'BASE64' }), null);
  assert.equal(wirePart(null), null);
});

test('wireItem drops item types outside the profile allowlist', () => {
  const base = new Set(BASE_REPLAYABLE_ITEM_TYPES);
  assert.equal(wireItem({ type: 'web_search_call', id: 'ws_1' }, base), null);
  const extended = new Set([...BASE_REPLAYABLE_ITEM_TYPES, 'web_search_call']);
  assert.deepEqual(
    wireItem({ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { sources: [] } }, extended),
    { type: 'web_search_call', id: 'ws_1', status: 'completed' }
  );
});

test('wireItem replays reasoning only when it carries the encrypted chain, and never its status', () => {
  const base = new Set(BASE_REPLAYABLE_ITEM_TYPES);
  assert.equal(wireItem({ type: 'reasoning', id: 'r1', summary: [] }, base), null);
  assert.deepEqual(
    wireItem({ type: 'reasoning', id: 'r1', summary: ['s'], encrypted_content: 'ENC', status: 'completed' }, base),
    { type: 'reasoning', encrypted_content: 'ENC', id: 'r1', summary: ['s'] }
  );
});

test('wireItem normalizes function_call ids and argument encoding', () => {
  const base = new Set(BASE_REPLAYABLE_ITEM_TYPES);
  assert.deepEqual(
    wireItem({ type: 'function_call', id: 'fc_1', name: 'read_file', arguments: { path: '/x' }, status: 'completed' }, base),
    { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '{"path":"/x"}' }
  );
  assert.equal(wireItem({ type: 'function_call', name: 'read_file' }, base), null);
});

test('buildResponsesInput sanitizes role items and preserves order', () => {
  const input = buildResponsesInput([
    { role: 'system', content: [{ type: 'input_text', text: 'static' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'ciao' }, { type: 'bogus' }] },
    { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'done' },
    { role: 'user', content: [] }
  ]);
  assert.deepEqual(input, [
    { role: 'system', content: [{ type: 'input_text', text: 'static' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'ciao' }] },
    { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'done' }
  ]);
});

test('buildResponsesBody is SSE-only and stateless by construction', () => {
  const body = buildResponsesBody({ model: 'm', input: [], reasoningEffort: 'high', maxOutputTokens: 100 });
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal('previous_response_id' in body, false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.max_output_tokens, 100);
  assert.equal('tools' in body, false);
  assert.equal('text' in body, false);
});

test('buildResponsesBody preserves the supported no-reasoning effort', () => {
  const body = buildResponsesBody({ model: 'gpt-5.6-sol', input: [], reasoningEffort: 'none' });
  assert.deepEqual(body.reasoning, { effort: 'none' });
});

test('buildResponsesBody attaches strict structured output as text.format', () => {
  const format = { type: 'json_schema', name: 'gemix_reply', strict: true, schema: {} };
  const body = buildResponsesBody({ model: 'm', input: [], responseFormat: format });
  assert.deepEqual(body.text, { format });
});

test('toolsToWire flattens function tools and passes native tool objects through', () => {
  const wire = toolsToWire([
    { type: 'function', function: { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } } },
    { type: 'x_search', limit: 5 },
    { type: 'function' },
    null
  ]);
  assert.deepEqual(wire, [
    { type: 'function', name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } },
    { type: 'x_search', limit: 5 }
  ]);
  assert.equal(toolsToWire([]), null);
});

test('pickAssistantText prefers the last message that parses as a structured reply', () => {
  assert.equal(
    pickAssistantText(['Sto cercando…', '{"response":"eccolo"}', 'coda']),
    '{"response":"eccolo"}'
  );
  assert.equal(pickAssistantText(['a', 'b']), 'b');
  assert.equal(pickAssistantText([]), '');
});

test('readResponse extracts text, tool calls and replay items', () => {
  const read = readResponse({
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'r1', encrypted_content: 'ENC' },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"response":"ok"}' }] }
    ]
  });
  assert.equal(read.text, '{"response":"ok"}');
  assert.deepEqual(read.toolCalls, [{ id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' }]);
  assert.equal(read.replayItems.length, 3);
  assert.equal(read.status, 'completed');
});
