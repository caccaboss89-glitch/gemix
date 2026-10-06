// test/claude-agent-engine.test.js
//
// Whole turns on the Claude Agent runtime through the real handler, with
// Claude Code replaced by a scripted query(): the options every turn starts
// from, a tool round through the MCP adapter and the hooks, the structured
// reply and its text fallbacks, and the refusals that end a turn early.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { afterEach } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import {
  CREDIT_EXHAUSTED_MESSAGE,
  FALLBACK_ERROR_PREFIX,
  PROVIDER_AUTH_MESSAGE
} from '../src/config/systemMessages.js';
import { _setClaudeQueryForTests } from '../src/ai/claudeAgent/claudeCode.js';
import { _resetActiveProfileForTests, resolveProviderProfile } from '../src/ai/providers/providerProfile.js';
import { handleMessage } from '../src/handler.js';
import { getWorkspaceMetaDir, resolveWorkspaceId } from '../src/utils/workspaceId.js';

const INIT = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  model: 'claude-sonnet-5-5',
  claude_code_version: '2.1.291'
};
const ALLOWED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 4102444800 } },
    isUsingOverage: false
  }
};

function assistant(content, { id = 'msg_1', error } = {}) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id, model: error ? '<synthetic>' : 'claude-sonnet-5-5', content },
    ...(error ? { error } : {})
  };
}

function result(fields) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 },
    result: '',
    ...fields
  };
}

/** A query() stand-in that records what the engine passed and plays a script. */
function scriptedQuery(script) {
  const seen = { closed: false };
  _setClaudeQueryForTests(({ prompt, options }) => {
    seen.options = options;
    const messages = (async function* () {
      for await (const message of prompt) seen.prompt = message;
      yield* script(options);
    })();
    messages.close = () => { seen.closed = true; };
    return messages;
  });
  return seen;
}

async function mcpClient(options) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await options.mcpServers.gemix.instance.connect(serverTransport);
  const client = new Client({ name: 'claude-code-stand-in', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

function claudeContext(t) {
  const saved = { provider: envConfig.AI_PROVIDER, token: envConfig.CLAUDE_CODE_OAUTH_TOKEN };
  envConfig.AI_PROVIDER = 'claude';
  envConfig.CLAUDE_CODE_OAUTH_TOKEN = 'test-claude-token';
  _resetActiveProfileForTests();

  const id = `claude-engine-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const ctx = {
    platform: constants.PLATFORM_DISCORD, userId: id, chatId: `thread-${id}`,
    content: 'what is in my workspace?', history: [], isGroup: false,
    userIdentity: { isActiveMember: true, isAdmin: true, isLegal: false, member: null, taskFileId: id }
  };
  t.after(() => {
    envConfig.AI_PROVIDER = saved.provider;
    envConfig.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
    _resetActiveProfileForTests();
    fs.rmSync(getWorkspaceMetaDir(resolveWorkspaceId(ctx)), { recursive: true, force: true });
  });
  return ctx;
}

afterEach(() => { _setClaudeQueryForTests(null); });

test('a Claude turn runs a tool round through the MCP adapter and answers with the structured reply', async (t) => {
  const ctx = claudeContext(t);
  let toolResult = null;
  let roundNote = null;
  const seen = scriptedQuery(async function* (options) {
    yield INIT;
    yield ALLOWED;
    yield assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__gemix__list_files', input: {} }]);
    const client = await mcpClient(options);
    toolResult = await client.callTool({
      name: 'list_files',
      arguments: { path: 'workspace/' },
      _meta: { 'claudecode/toolUseId': 'toolu_1' }
    });
    await client.close();
    roundNote = await options.hooks.PostToolBatch[0].hooks[0]({
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'mcp__gemix__list_files', tool_use_id: 'toolu_1', tool_input: {} }]
    });
    yield assistant([{ type: 'tool_use', id: 'toolu_2', name: 'StructuredOutput', input: {} }], { id: 'msg_2' });
    yield result({ num_turns: 2, structured_output: { response: 'done', attachments: null, conversation_title: '' } });
  });

  const reply = await handleMessage(ctx);
  assert.equal(reply.text, 'done');
  assert.equal(seen.closed, true);
  assert.equal(JSON.parse(toolResult.content[0].text).success, true);
  assert.deepEqual(roundNote, {});

  const { options, prompt } = seen;
  assert.equal(options.model, resolveProviderProfile().model);
  assert.equal(options.effort, 'medium');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, ['mcp__gemix__*']);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.permissionMode, 'dontAsk');
  assert.equal(options.cwd, constants.CLAUDE_CODE_WORK_DIR);
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, 'test-claude-token');
  assert.equal(Object.keys(options.env).some(key => key.startsWith('ANTHROPIC_')), false);
  assert.ok(options.systemPrompt.length > 0);
  assert.ok(options.outputFormat.schema.required.includes('conversation_title'));

  assert.equal(prompt.type, 'user');
  assert.equal(prompt.parent_tool_use_id, null);
  const text = prompt.message.content.map(block => block.text).join('');
  assert.match(text, /<user_query>[\s\S]*what is in my workspace\?/);
  assert.ok(text.indexOf('<Runtime>') > text.indexOf('<user_query>'));
});

test('a turn whose structured reply never validated answers with what the model wrote', async (t) => {
  const ctx = claudeContext(t);
  scriptedQuery(async function* () {
    yield INIT;
    yield assistant([{ type: 'text', text: 'plain answer' }]);
    yield result({ subtype: 'error_max_structured_output_retries', is_error: true, errors: [] });
  });
  assert.equal((await handleMessage(ctx)).text, 'plain answer');

  const salvaged = claudeContext(t);
  scriptedQuery(async function* () {
    yield INIT;
    yield assistant([{ type: 'text', text: 'thinking out loud' }]);
    yield assistant([{
      type: 'tool_use',
      id: 'toolu_9',
      name: 'StructuredOutput',
      input: { response: 'the real reply', attachments: ['/etc/passwd'], conversation_title: '' }
    }]);
    yield result({ subtype: 'error_max_structured_output_retries', is_error: true, errors: [] });
  });
  const reply = await handleMessage(salvaged);
  assert.equal(reply.text, 'the real reply');
  assert.deepEqual(reply.attachments, []);
});

test('a request drawing on extra usage stops the turn with the credit notice', async (t) => {
  const ctx = claudeContext(t);
  let reachedResult = false;
  const seen = scriptedQuery(async function* () {
    yield INIT;
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true, rateLimitType: 'five_hour' } };
    reachedResult = true;
    yield result({ structured_output: { response: 'paid answer', attachments: null, conversation_title: '' } });
  });
  assert.equal((await handleMessage(ctx)).text, CREDIT_EXHAUSTED_MESSAGE);
  assert.equal(reachedResult, false);
  assert.equal(seen.closed, true);
});

test('an API credential seen by Claude Code, or a rejected token, ends the turn as an auth failure', async (t) => {
  const keyed = claudeContext(t);
  scriptedQuery(async function* () {
    yield { ...INIT, apiKeySource: 'ANTHROPIC_API_KEY' };
    yield result({ structured_output: { response: 'billed answer', attachments: null, conversation_title: '' } });
  });
  assert.equal((await handleMessage(keyed)).text, PROVIDER_AUTH_MESSAGE);

  const rejected = claudeContext(t);
  scriptedQuery(async function* () {
    yield INIT;
    yield assistant([{ type: 'text', text: 'Failed to authenticate.' }], { error: 'authentication_failed' });
    yield result({ is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401' });
  });
  assert.equal((await handleMessage(rejected)).text, PROVIDER_AUTH_MESSAGE);
});

test('a Claude Code process that dies mid-turn falls back to the generic error reply', async (t) => {
  const ctx = claudeContext(t);
  const seen = scriptedQuery(async function* () {
    yield INIT;
    throw new Error('Claude Code process exited with code 1');
  });
  const reply = await handleMessage(ctx);
  assert.ok(reply.text.startsWith(FALLBACK_ERROR_PREFIX));
  assert.equal(seen.closed, true);
});
