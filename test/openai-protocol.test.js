// test/openai-protocol.test.js
//
// Phase 3: the Codex Responses wire format — request building, SSE decoding
// under hostile chunking, canonical item assembly, and the reading helpers
// (assistant message, search sources and citations).
//
// Everything here runs off the sanitized fixtures in test/fixtures/openai.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

const AUTH_FILE = writeAuthFile();
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const {
  joinUrl,
  buildResponsesInput,
  buildResponsesBody,
  toolsToWire,
  toolContentToOutput,
  SseDecoder,
  ResponseAssembler,
  responseToAssistantMessage,
  extractSearchStats,
  collectSearchSources,
  collectCitations
} = await import('../src/ai/openaiResponsesProtocol.js');

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai');
const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

/** Decode a whole stream, cut into chunks of `size` bytes. */
function decodeStream(text, size) {
  const bytes = Buffer.from(text, 'utf8');
  const decoder = new SseDecoder();
  const assembler = new ResponseAssembler();
  for (let i = 0; i < bytes.length; i += size) {
    for (const event of decoder.push(bytes.subarray(i, i + size))) assembler.apply(event);
  }
  for (const event of decoder.end()) assembler.apply(event);
  return assembler;
}

// -- Request building --------------------------------------------------------

test('base URL join keeps the configured path segment', () => {
  assert.equal(joinUrl('https://chatgpt.com/backend-api/codex', 'responses'), 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(joinUrl('https://chatgpt.com/backend-api/codex/', '/responses'), 'https://chatgpt.com/backend-api/codex/responses');
});

test('request body is an allowlist: no xAI field and no server-side state', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.6-sol',
    effort: 'max',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: toolsToWire([{ type: 'function', function: { name: 'bug_report', description: 'd', parameters: { type: 'object', properties: {} } } }]),
    responseFormat: { type: 'json_schema', name: 'gemix_reply', strict: true, schema: {} }
  });

  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.deepEqual(body.reasoning, { effort: 'max' });
  assert.deepEqual(body.include, ['web_search_call.action.sources']);
  assert.equal(body.text.format.name, 'gemix_reply');
  for (const forbidden of ['previous_response_id', 'max_turns', 'prompt_cache_key', 'conversation']) {
    assert.equal(forbidden in body, false, `${forbidden} must never be sent`);
  }
});

test('hosted search is forced to text-only and function tools are flattened', () => {
  const wire = toolsToWire([
    { type: 'web_search', search_content_types: ['image', 'text'], image_settings: { max_results: 3, caption: true } },
    { type: 'function', function: { name: 'build', description: 'd', parameters: { type: 'object', properties: {} } } }
  ]);
  assert.deepEqual(wire[0], { type: 'web_search' });
  assert.equal(wire[1].type, 'function');
  assert.equal(wire[1].name, 'build');
  assert.equal('function' in wire[1], false);
});

test('input[] rebuilds the window and replays only observed item shapes', () => {
  const input = buildResponsesInput([
    { role: 'system', content: 'static' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'input_image', image_url: 'https://example.invalid/a.png' }] },
    {
      role: 'assistant',
      content: '',
      _responsesOutput: [
        { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'ENC' },
        { type: 'reasoning', id: 'rs_2', status: 'completed' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_image_search', arguments: '{}', status: 'completed' },
        { type: 'web_search_call', id: 'ws_1', status: 'completed', results: [{ type: 'image_result', image_url: 'https://cdn.example.invalid/x.webp' }] },
        { type: 'local_shell_call', id: 'sh_1' }
      ]
    },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '{"success":true}' }, { type: 'input_image', image_url: 'https://example.invalid/hit.png' }] }
  ]);

  assert.deepEqual(input, [
    { role: 'system', content: [{ type: 'input_text', text: 'static' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'https://example.invalid/a.png' }] },
    // Reasoning without encrypted_content and the unobserved shell item are dropped.
    { type: 'reasoning', encrypted_content: 'ENC', id: 'rs_1', summary: undefined },
    { type: 'function_call', call_id: 'call_1', name: 'web_image_search', arguments: '{}' },
    // Hosted results are replayed by reference, never re-uploaded.
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"success":true}' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.invalid/hit.png' }] }
  ].map(item => JSON.parse(JSON.stringify(item))));
});

test('tool results split into an output string plus separate input parts', () => {
  const { output, extraParts } = toolContentToOutput([
    { type: 'text', text: '{"success":true}' },
    { type: 'input_file', file_url: 'https://example.invalid/doc.pdf' }
  ]);
  assert.equal(output, '{"success":true}');
  assert.deepEqual(extraParts, [{ type: 'input_file', file_url: 'https://example.invalid/doc.pdf' }]);
});

// -- SSE decoding ------------------------------------------------------------

test('a complete item only present on output_item.done survives assembly', () => {
  const assembler = decodeStream(fixture('function-loop.sse.txt'), 4096);
  const response = assembler.toResponse();
  assert.equal(response.status, 'completed');

  const call = response.output.find(i => i.type === 'function_call');
  assert.ok(call, 'the function call must not be lost when response.completed omits it');
  assert.equal(call.call_id, 'call_fixture_1');
  assert.equal(call.arguments, '{"query":"placeholder"}');

  const reasoning = response.output.find(i => i.type === 'reasoning');
  assert.equal(reasoning.encrypted_content, 'ENCRYPTED_REASONING_PLACEHOLDER');
  assert.equal(response.usage.total_tokens, 154);
});

test('decoding is stable under any chunk size, CRLF and split UTF-8', () => {
  const text = fixture('function-loop.sse.txt');
  const reference = JSON.stringify(decodeStream(text, 4096).toResponse());
  for (const size of [1, 2, 3, 7, 13, 64, 997]) {
    assert.equal(JSON.stringify(decodeStream(text, size).toResponse()), reference, `chunk size ${size}`);
  }
  // Same stream with CRLF line endings must decode identically.
  assert.equal(JSON.stringify(decodeStream(text.replace(/\n/g, '\r\n'), 5).toResponse()), reference);
});

test('multi-byte characters split across chunks are not corrupted', () => {
  const payload = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"città 😀 naïve"}]}}\n\n';
  const assembler = decodeStream(payload, 1);
  const text = assembler.toResponse().output[0].content[0].text;
  assert.equal(text, 'città 😀 naïve');
});

test('comments, blank lines, [DONE] and a malformed event are tolerated', () => {
  const stream = ': hello\n\n'
    + 'data: not json at all\n\n'
    + 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n'
    + 'data: [DONE]\n\n';
  const response = decodeStream(stream, 3).toResponse();
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].content[0].text, 'ok');
});

test('a duplicated done event does not duplicate the item', () => {
  const line = 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"once"}]}}\n\n';
  assert.equal(decodeStream(line + line, 64).toResponse().output.length, 1);
});

test('EOF without a terminal event yields a partial, flagged response', () => {
  const assembler = decodeStream(fixture('incomplete.sse.txt'), 32);
  assert.equal(assembler.status, null);
  assert.equal(assembler.sawMeaningfulEvent, true);
  assert.equal(assembler.toResponse().output.length, 1);
});

test('response.failed and error events are surfaced', () => {
  const failed = decodeStream('data: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"message":"placeholder failure"}}}\n\n', 16);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'placeholder failure');

  const errored = decodeStream('data: {"type":"error","error":{"message":"stream error"}}\n\n', 16);
  assert.equal(errored.error.message, 'stream error');
});

test('response.incomplete carries its reason', () => {
  const assembler = decodeStream('data: {"type":"response.incomplete","response":{"id":"r","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n', 16);
  assert.equal(assembler.status, 'incomplete');
  assert.equal(assembler.incompleteReason, 'max_output_tokens');
});

// -- Reading the assembled response -----------------------------------------

test('assistant message carries tool calls and replayable items', () => {
  const response = decodeStream(fixture('function-loop.sse.txt'), 256).toResponse();
  const message = responseToAssistantMessage(response);
  assert.deepEqual(message.tool_calls, [
    { id: 'call_fixture_1', type: 'function', function: { name: 'web_image_search', arguments: '{"query":"placeholder"}' } }
  ]);
  assert.equal(message._responsesOutput.length, 2);
});

test('hosted search yields deduplicated real sources and clean citations', () => {
  const response = decodeStream(fixture('web-search.sse.txt'), 512).toResponse();

  const sources = collectSearchSources(response);
  assert.equal(sources.length, 3, 'duplicate URLs collapse while the named feed survives');
  assert.deepEqual(sources.map(source => source.url), [
    'https://example.invalid/alpha',
    'https://example.invalid/beta',
    null
  ]);
  assert.deepEqual(extractSearchStats(response), {
    webSources: 3,
    xPosts: 0,
    webSourceKeys: [
      'url:https://example.invalid/alpha',
      'url:https://example.invalid/beta',
      'feed:oai-weather:weather'
    ]
  });

  const citations = collectCitations(response);
  assert.equal(citations.length, 2, 'duplicate URLs collapse, distinct ones survive');
  assert.equal(citations[0].url, 'https://example.invalid/alpha');
  assert.equal(citations[0].start, 12);
  // Out-of-range offsets are dropped rather than trusted.
  assert.equal(citations[1].url, 'https://example.invalid/beta');
  assert.equal(citations[1].start, null);
});

test('the last structured message wins when the loop narrates itself', () => {
  const response = {
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Sto cercando...' }] },
      { type: 'message', content: [{ type: 'output_text', text: '{"response":"final answer"}' }] }
    ]
  };
  assert.equal(responseToAssistantMessage(response).content, '{"response":"final answer"}');
});
