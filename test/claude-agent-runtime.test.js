// test/claude-agent-runtime.test.js
//
// The Claude Agent runtime's local contracts: the Claude Code process sees an
// allowlisted environment with the subscription token as its only credential,
// concurrent turns queue behind a bounded semaphore, the conversation becomes
// one user message, GemiX tools answer through the MCP adapter, rounds keep
// GemiX's caps and wrap-up, and Claude Code's refusals become typed failures.

import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { claudeCodeEnv } from '../src/ai/claudeAgent/claudeCode.js';
import { rateLimitFailure, resultFailure } from '../src/ai/claudeAgent/claudeFailures.js';
import { createClaudeTurnControl } from '../src/ai/claudeAgent/claudeTurnControl.js';
import { HISTORY_REPLY_LABEL, renderClaudeUserContent } from '../src/ai/claudeAgent/claudeUserContent.js';
import { createGemixMcpServer, toMcpContent } from '../src/ai/claudeAgent/gemixMcpServer.js';
import { assistantTextItem, userItem } from '../src/ai/responsesItems.js';
import { TRANSPORT_ERROR } from '../src/ai/transport/errors.js';
import { createSemaphore } from '../src/utils/concurrency.js';
import { clearLiveMessages, openLiveInbox, recordLiveMessage } from '../src/utils/liveInbox.js';
import { createTurnBudgets } from '../src/utils/turnBudget.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('the Claude Code environment carries the subscription token and nothing else secret', () => {
  const env = claudeCodeEnv({ configDir: '/gemix/claude/config', oauthToken: 'subscription-token' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/gemix/claude/config');
  assert.equal(Object.keys(env).some(key => key.startsWith('ANTHROPIC_')), false);
  const own = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
    'DISABLE_AUTOUPDATER',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  ]);
  for (const key of Object.keys(env)) {
    assert.ok(own.has(key) || key in envConfig.SUBPROCESS_BASE_ENV, `${key} is not allowlisted`);
  }
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in claudeCodeEnv({ configDir: '/c' }), false);
});

test('the semaphore hands slots over in arrival order and releases once per holder', async () => {
  const semaphore = createSemaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  const order = [];
  const third = semaphore.acquire().then(release => { order.push('third'); return release; });
  const fourth = semaphore.acquire().then(release => { order.push('fourth'); return release; });
  assert.equal(semaphore.waiting, 2);

  first();
  first();
  const releaseThird = await third;
  assert.deepEqual(order, ['third']);
  assert.equal(semaphore.active, 2);
  assert.equal(semaphore.waiting, 1);

  second();
  (await fourth)();
  releaseThird();
  assert.deepEqual(order, ['third', 'fourth']);
  assert.equal(semaphore.active, 0);
});

test('a waiter whose signal aborts leaves the queue without taking a slot', async () => {
  const semaphore = createSemaphore(1);
  const holder = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort(new Error('turn deadline'));
  await assert.rejects(waiting, /turn deadline/);
  assert.equal(semaphore.waiting, 0);
  holder();
  assert.equal(semaphore.active, 0);
  await assert.rejects(semaphore.acquire(controller.signal), /turn deadline/);
});

test('the conversation becomes one user message with history, request and Runtime in order', () => {
  const blocks = renderClaudeUserContent({
    history: [
      userItem('[10:01] Anna: look at this'),
      userItem([{ type: 'input_image', image_url: PNG }]),
      assistantTextItem('Nice photo'),
      userItem([{ type: 'input_image', image_url: 'data:image/bmp;base64,Qk0=' }])
    ],
    query: userItem([
      { type: 'input_text', text: '<user_query>and this?</user_query>' },
      { type: 'input_image', image_url: 'https://example.invalid/a.jpg' }
    ]),
    runtime: userItem('<Runtime>now</Runtime>')
  });

  assert.deepEqual(blocks.map(block => block.type), ['text', 'image', 'text', 'image', 'text']);
  assert.equal(blocks[0].text, '<conversation-history>\n[10:01] Anna: look at this\n');
  assert.deepEqual(blocks[1].source, { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(blocks[2].text, `\n${HISTORY_REPLY_LABEL} Nice photo\n`
    + '[image not shown: image/bmp is not a supported image type; convert a copy to PNG in workspace/ with shell '
    + 'and read that]\n</conversation-history>\n\n'
    + '<user_query>and this?</user_query>');
  assert.deepEqual(blocks[3].source, { type: 'url', url: 'https://example.invalid/a.jpg' });
  assert.equal(blocks[4].text, '\n\n<Runtime>now</Runtime>');
});

test('an image larger than the model accepts becomes a note instead of failing the request', () => {
  const huge = `data:image/jpeg;base64,${'A'.repeat(5 * 1024 * 1024 + 1)}`;
  const blocks = renderClaudeUserContent({
    history: [],
    query: userItem([{ type: 'input_image', image_url: huge }]),
    runtime: userItem('<Runtime/>')
  });
  assert.deepEqual(blocks, [{
    type: 'text',
    text: '[image not shown: larger than the model accepts; shrink a copy in workspace/ with shell and read that]'
      + '\n\n<Runtime/>'
  }]);
});

test('tool results keep their envelope and images in order as MCP content', () => {
  assert.deepEqual(toMcpContent('{"success":true}'), [{ type: 'text', text: '{"success":true}' }]);
  assert.deepEqual(toMcpContent({ success: true, status: 'ok' }), [{ type: 'text', text: '{"success":true,"status":"ok"}' }]);
  assert.deepEqual(toMcpContent([
    { type: 'input_text', text: '{"success":true}' },
    { type: 'input_text', text: '[read_file IMAGE_0]' },
    { type: 'input_image', image_url: PNG },
    { type: 'input_image', image_url: 'https://example.invalid/a.png' }
  ]), [
    { type: 'text', text: '{"success":true}' },
    { type: 'text', text: '[read_file IMAGE_0]' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'text', text: '[image not shown: unreadable image reference]' }
  ]);
});

test('the MCP adapter lists raw GemiX schemas and answers each call under its tool_use id', async () => {
  const parameters = {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 } },
    required: ['path'],
    additionalProperties: false
  };
  const calls = [];
  const server = createGemixMcpServer([
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters } },
    { type: 'function', function: { name: 'send_message', description: 'Send', parameters } }
  ], async (tc) => {
    calls.push(tc);
    return [{ type: 'input_text', text: '{"success":true}' }, { type: 'input_image', image_url: PNG }];
  });
  assert.equal(server.type, 'sdk');
  assert.equal(server.name, 'gemix');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => [tool.name, tool.annotations.readOnlyHint]), [
      ['read_file', true],
      ['send_message', false]
    ]);
    assert.deepEqual(tools[0].inputSchema, parameters);
    assert.equal(tools[0]._meta['anthropic/alwaysLoad'], true);

    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: 'workspace/a.png' },
      _meta: { 'claudecode/toolUseId': 'toolu_1' }
    });
    assert.deepEqual(calls, [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"workspace/a.png"}' }]);
    assert.deepEqual(result.content, [
      { type: 'text', text: '{"success":true}' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ]);
  } finally {
    await client.close();
  }
});

function turnControl(t, { executeTool, tools = [], platformCtx = {} } = {}) {
  const budgets = createTurnBudgets(60_000, 1_000);
  t.after(() => { budgets.work.dispose(); budgets.root.dispose(); });
  const control = createClaudeTurnControl({
    state: { userCtx: {}, responseCtx: {}, deliveryCtx: {}, platformCtx },
    liveTools: () => tools,
    workBudget: budgets.work,
    signal: budgets.root.signal,
    executeTool
  });
  const batch = names => control.hooks.PostToolBatch[0].hooks[0]({
    hook_event_name: 'PostToolBatch',
    tool_calls: names.map((name, i) => ({ tool_name: name, tool_use_id: `toolu_${i}`, tool_input: {} }))
  });
  const beforeTool = name => control.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name });
  return { control, budgets, batch, beforeTool };
}

const tool = name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });

test('each call is re-authorized against the tools held when it runs', async (t) => {
  const tools = [tool('read_file')];
  const executed = [];
  const { control } = turnControl(t, {
    tools,
    executeTool: async (call) => {
      executed.push(call.function.name);
      return { result: '{"success":true}' };
    }
  });
  assert.equal(await control.runCall({ id: 'a', name: 'read_file', arguments: '{}' }), '{"success":true}');
  tools.length = 0;
  const refused = JSON.parse(await control.runCall({ id: 'b', name: 'read_file', arguments: '{}' }));
  assert.equal(refused.success, false);
  assert.deepEqual(executed, ['read_file']);
});

test('per-round caps count calls as they arrive and reset when the round closes', async (t) => {
  const { control, batch } = turnControl(t, {
    tools: [tool('read_music_stats')],
    executeTool: async () => ({ result: '{"success":true}' })
  });
  const call = () => control.runCall({ id: 'x', name: 'read_music_stats', arguments: '{}' });
  assert.equal(await call(), '{"success":true}');
  assert.match(await call(), /once per round/);
  await batch(['mcp__gemix__read_music_stats', 'mcp__gemix__read_music_stats']);
  assert.equal(await call(), '{"success":true}');
});

test('only GemiX batches are rounds, and the round cap wraps the turn up', async (t) => {
  const { control, batch, beforeTool } = turnControl(t);
  assert.deepEqual(await batch(['StructuredOutput']), {});
  assert.equal(control.rounds, 0);

  for (let round = 1; round < constants.MAX_TOOL_ROUNDS; round++) {
    assert.deepEqual(await batch(['mcp__gemix__read_file']), {});
  }
  assert.deepEqual(await beforeTool('mcp__gemix__read_file'), {});
  const last = await batch(['mcp__gemix__read_file']);
  assert.equal(control.rounds, constants.MAX_TOOL_ROUNDS);
  assert.equal(control.wrapUpReason, 'round_cap');
  assert.equal(last.hookSpecificOutput.hookEventName, 'PostToolBatch');
  assert.match(last.hookSpecificOutput.additionalContext, /you can no longer run tools for this turn/);

  const refused = await beforeTool('mcp__gemix__read_file');
  assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(refused.hookSpecificOutput.permissionDecisionReason, /^<system-reminder>That call did not run\. .*you can no longer run tools/s);
  assert.deepEqual(await beforeTool('StructuredOutput'), {});
});

test('a round closes with the messages that arrived meanwhile, then the deadline note', async (t) => {
  const chatKey = `claude-control-${process.pid}`;
  openLiveInbox(chatKey);
  t.after(() => clearLiveMessages(chatKey));
  const { control, budgets, batch } = turnControl(t, { platformCtx: { liveInboxKey: chatKey } });

  recordLiveMessage(chatKey, { userName: 'Anna', text: 'also check the weather', timestampMs: Date.UTC(2026, 9, 6, 10, 0) });
  const first = await batch(['mcp__gemix__search_web']);
  assert.match(first.hookSpecificOutput.additionalContext, /also check the weather/);
  assert.equal(control.wrapUpReason, null);

  budgets.work._controller.abort();
  const second = await batch(['mcp__gemix__search_web']);
  assert.equal(control.wrapUpReason, 'deadline');
  assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /also check the weather/);
  assert.match(second.hookSpecificOutput.additionalContext, /work deadline/);
});

test('Claude Code refusals become the typed failures every runtime raises', () => {
  const failed = (result, seen) => resultFailure({ subtype: 'success', is_error: true, ...result }, seen);
  assert.equal(failed({ result: 'API Error: 401 Invalid bearer token', api_error_status: 401 }).kind, TRANSPORT_ERROR.AUTH);
  assert.equal(failed({ result: 'Not logged in · Please run /login' }).kind, TRANSPORT_ERROR.AUTH);
  assert.equal(failed({ result: 'limit' }, { assistantError: 'rate_limit', rateLimit: { status: 'rejected' } }).kind,
    TRANSPORT_ERROR.QUOTA);
  assert.equal(failed({ result: 'slow down' }, { assistantError: 'rate_limit', rateLimit: { status: 'allowed' } }).kind,
    TRANSPORT_ERROR.RATE_LIMIT);
  assert.equal(failed({ result: 'oops' }, { assistantError: 'oauth_org_not_allowed' }).kind, TRANSPORT_ERROR.AUTH);
  const crashed = resultFailure({ subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
  assert.equal(crashed.kind, TRANSPORT_ERROR.MALFORMED);
  assert.match(crashed.message, /error_during_execution.*boom/);
});

test('the quota guard stops a turn that is rejected or drawing on extra usage', () => {
  const windows = { five_hour: { utilization: 0.4, resetsAt: 4102444800 } };
  assert.equal(rateLimitFailure({ status: 'allowed', unifiedWindows: windows, isUsingOverage: false }), null);
  assert.equal(rateLimitFailure({ status: 'allowed', unifiedWindows: windows, isUsingOverage: true }).kind,
    TRANSPORT_ERROR.QUOTA);
  assert.equal(rateLimitFailure({ status: 'allowed', overageInUse: true }).kind, TRANSPORT_ERROR.QUOTA);
  assert.equal(rateLimitFailure({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 4102444800 }).kind,
    TRANSPORT_ERROR.QUOTA);
});
