// test/golden-xai-wire.test.js
//
// Phase 0 characterization of the xAI wire surface: the exact request the main
// brain sends (model, reasoning, store, include, max_turns, prompt cache key,
// sticky-routing header, tool order, structured output), the adapter's
// input[]/output[] translation including reasoning replay, the server-side
// search stats, and the credit-exhaustion detector.
//
// Everything here is behaviour the OpenAI work must leave untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub } from './helpers/fetchStub.js';

seedEnv({ XAI_AUTH_FILE: writeAuthFile() });

const { callAI } = await import('../src/ai/aiProvider.js');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats
} = await import('../src/ai/responsesAdapter.js');
const { getToolsForUser } = await import('../src/ai/tools.js');
const { buildGemixResponseFormat } = await import('../src/ai/responseSchema.js');
const { isGrokCreditExhaustedError } = await import('../src/ai/apiClient.js');
const { buildResearchBadgeText, getModelDisplayName } = await import('../src/utils/footer.js');
const constants = (await import('../src/config/constants.js')).default;
const envConfig = (await import('../src/config/env.js')).default;

const COMPLETED = {
  id: 'resp_test',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"response":"ok"}' }] }]
};

test('callAI sends the xAI Responses request unchanged', async () => {
  const stub = installFetchStub(() => COMPLETED);
  try {
    const tools = getToolsForUser(true, true, { platform: constants.PLATFORM_WA_DEDICATED, isGroup: false });
    const result = await callAI(
      [{ role: 'system', content: 'static' }, { role: 'user', content: 'hi' }],
      tools,
      {
        responseFormat: buildGemixResponseFormat({ includeTitle: false, allowVoice: true }),
        promptCacheKey: 'conv-abc',
        reasoningEffort: 'medium',
        maxTurns: constants.MAX_TOOL_ROUNDS,
        requestId: 'req-1'
      }
    );

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, 'https://api.x.ai/v1/responses');
    assert.equal(call.headers.Authorization, 'Bearer xai-test-token');
    assert.equal(call.headers['x-grok-conv-id'], 'conv-abc');

    const body = JSON.parse(call.body);
    assert.equal(body.model, envConfig.GROK_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, constants.MAX_TOKENS);
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(body.prompt_cache_key, 'conv-abc');
    assert.equal(body.max_turns, constants.MAX_TOOL_ROUNDS);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.text.format.name, 'gemix_reply');
    // Native tool types are passed through verbatim, in registry order.
    assert.deepEqual(
      body.tools.map(t => t.name || t.type),
      chatToolsToResponsesTools(tools).map(t => t.name || t.type)
    );
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(result.provider, 'Grok');
    assert.equal(result.model, envConfig.GROK_MODEL);
  } finally {
    stub.restore();
  }
});

test('unknown reasoning effort falls back to high', async () => {
  const stub = installFetchStub(() => COMPLETED);
  try {
    await callAI([{ role: 'user', content: 'hi' }], null, { reasoningEffort: 'max' });
    assert.deepEqual(JSON.parse(stub.calls[0].body).reasoning, { effort: 'high' });
  } finally {
    stub.restore();
  }
});

test('chat messages translate to Responses input[] with reasoning replay', () => {
  const { input } = chatMessagesToResponsesInput([
    { role: 'system', content: 'static' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'input_image', image_url: 'https://x/y.png' }] },
    {
      role: 'assistant',
      content: '',
      _responsesOutput: [
        { type: 'reasoning', id: 'rs_1', status: 'completed', encrypted_content: 'ENC' },
        {
          type: 'function_call',
          id: 'fc_srv',
          call_id: 'call_1',
          name: 'web_image_search',
          arguments: '{"query":"x"}',
          status: 'completed'
        },
        { type: 'web_search_call', id: 'ws_1', action: { type: 'search', sources: ['a', 'b'] } }
      ]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: '{"success":true}' },
        { type: 'input_image', image_url: 'https://x/hit.png' }
      ]
    }
  ]);

  assert.deepEqual(input, [
    { role: 'system', content: 'static' },
    { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'https://x/y.png' }] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
    { type: 'function_call', call_id: 'call_1', name: 'web_image_search', arguments: '{"query":"x"}' },
    { type: 'web_search_call', id: 'ws_1', action: { type: 'search', sources: ['a', 'b'] } },
    { type: 'function_call_output', call_id: 'call_1', output: '{"success":true}' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'https://x/hit.png' }] }
  ]);
});

test('responses output[] maps back to an assistant message', () => {
  const msg = responsesToAssistantMessage({
    output: [
      { type: 'reasoning', encrypted_content: 'ENC' },
      { type: 'message', content: [{ type: 'output_text', text: 'first step' }] },
      { type: 'function_call', call_id: 'call_9', name: 'build', arguments: '{"prompt":"x"}' }
    ]
  });
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'first step');
  assert.deepEqual(msg.tool_calls, [
    { id: 'call_9', type: 'function', function: { name: 'build', arguments: '{"prompt":"x"}' } }
  ]);
  assert.equal(msg._responsesOutput.length, 3);
});

test('server-side search stats count web sources and X posts', () => {
  const stats = extractServerSearchStats({
    output: [
      { type: 'web_search_call', action: { type: 'search', sources: ['a', 'b', 'c'] } },
      { type: 'web_search_call', action: { type: 'open_page' } },
      { type: 'custom_tool_call', name: 'x_keyword_search', input: '{"limit":5}' },
      { type: 'custom_tool_call', name: 'x_thread_fetch', input: '{}' }
    ]
  });
  assert.deepEqual(stats, { webSources: 4, xPosts: 6 });
  assert.equal(buildResearchBadgeText(stats), '🌐: 4 sources. 𝕏: 6 posts.');
});

test('SuperGrok credit exhaustion is detected on every observed shape', () => {
  assert.equal(isGrokCreditExhaustedError('HTTP 403: {"code":"personal-team-blocked:spending-limit"}'), true);
  assert.equal(isGrokCreditExhaustedError('Grok API credit exhausted after 3 attempt(s)'), true);
  assert.equal(isGrokCreditExhaustedError('HTTP 403: {"code":"unauthenticated:bad-credentials"}'), true);
  assert.equal(isGrokCreditExhaustedError('HTTP 500: boom'), false);
});

test('model display name stays Grok for the xAI slug', () => {
  assert.equal(getModelDisplayName('grok-4-latest'), 'Grok 4');
});
