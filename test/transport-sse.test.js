// test/transport-sse.test.js
//
// The SSE decoder and the response assembler: the two places where a lossy or
// awkwardly chunked stream could silently cost GemiX a tool call.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SseDecoder } from '../src/ai/transport/sse.js';
import { ResponseAssembler } from '../src/ai/transport/responsesProtocol.js';

const enc = (s) => new TextEncoder().encode(s);

test('SseDecoder parses events across LF and CRLF line endings', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(enc('data: {"a":1}\n\n')), [{ a: 1 }]);
  assert.deepEqual(d.push(enc('data: {"b":2}\r\n\r\n')), [{ b: 2 }]);
});

test('SseDecoder reassembles an event split across chunks', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(enc('data: {"a"')), []);
  assert.deepEqual(d.push(enc(':1}\n')), []);
  assert.deepEqual(d.push(enc('\n')), [{ a: 1 }]);
});

test('SseDecoder keeps a multi-byte character split across chunks intact', () => {
  const d = new SseDecoder();
  const bytes = enc('data: {"t":"è"}\n\n');
  const cut = 13; // lands inside the two-byte sequence
  d.push(bytes.slice(0, cut));
  const events = d.push(bytes.slice(cut));
  assert.deepEqual(events, [{ t: 'è' }]);
});

test('SseDecoder joins multiple data lines and ignores comments and [DONE]', () => {
  const d = new SseDecoder();
  const events = d.push(enc(': keep-alive\nevent: x\ndata: {"a":\ndata: 1}\n\ndata: [DONE]\n\n'));
  assert.deepEqual(events, [{ a: 1 }]);
});

test('SseDecoder drops one malformed event without poisoning the rest', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(enc('data: not json\n\ndata: {"ok":true}\n\n')), [{ ok: true }]);
});

test('SseDecoder flushes a stream that ends without a blank line', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.push(enc('data: {"a":1}')), []);
  assert.deepEqual(d.end(), [{ a: 1 }]);
});

test('ResponseAssembler lets a done item beat the lossy completed array', () => {
  const a = new ResponseAssembler();
  a.apply({
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' }
  });
  a.apply({
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      // The final array carries the same item stripped of its arguments.
      output: [{ id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'shell' }],
      usage: { total_tokens: 12 }
    }
  });
  const out = a.toResponse();
  assert.equal(out.output.length, 1);
  assert.equal(out.output[0].arguments, '{"cmd":"ls"}');
  assert.equal(out.status, 'completed');
  assert.equal(out.id, 'resp_1');
  assert.deepEqual(out.usage, { total_tokens: 12 });
});

test('ResponseAssembler keeps an item the completed array omitted entirely', () => {
  const a = new ResponseAssembler();
  a.apply({
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'fc_1', type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }
  });
  a.apply({
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [] }]
    }
  });
  const types = a.toResponse().output.map(i => i.type);
  assert.deepEqual(types, ['function_call', 'message']);
});

test('ResponseAssembler upgrades an added item when its done event arrives', () => {
  const a = new ResponseAssembler();
  a.apply({ type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message', content: [] } });
  a.apply({
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
  });
  const out = a.toResponse();
  assert.equal(out.output.length, 1);
  assert.equal(out.output[0].content[0].text, 'ok');
});

test('ResponseAssembler records errors, incomplete reasons and the meaningful-event flag', () => {
  const a = new ResponseAssembler();
  assert.equal(a.sawMeaningfulEvent, false);
  a.apply({ type: 'response.created', response: { id: 'r1' } });
  assert.equal(a.sawMeaningfulEvent, false);
  a.apply({ type: 'response.output_text.delta', delta: 'x' });
  assert.equal(a.sawMeaningfulEvent, true);

  const b = new ResponseAssembler();
  b.apply({ type: 'error', error: { message: 'boom' } });
  assert.equal(b.error.message, 'boom');

  const c = new ResponseAssembler();
  c.apply({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
  assert.equal(c.toResponse().incomplete_reason, 'max_output_tokens');
});
