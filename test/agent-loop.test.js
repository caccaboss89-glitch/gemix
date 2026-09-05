// test/agent-loop.test.js
//
// Real handler and provider integration: admission, model/tool rounds, reserved
// wrap-up, partial streams, preference snapshots and final file delivery.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { OpenAIResponsesTransport } from '../src/ai/transport/openAIResponsesTransport.js';
import { callAI, _resetProviderClientForTests, _setTransportForTests } from '../src/ai/aiProvider.js';
import { handleMessage } from '../src/handler.js';
import { TransportError, TRANSPORT_ERROR } from '../src/ai/transport/errors.js';
import { providerFailureReply } from '../src/ai/providers/errorPolicy.js';
import { resolveProviderProfile } from '../src/ai/providers/providerProfile.js';
import { readSettings, updateSettings } from '../src/utils/settingsStore.js';
import { resolveSettingsFileId } from '../src/utils/userPaths.js';
import { resolveWorkspaceId } from '../src/utils/workspaceId.js';
import workspaceRuntime from '../src/sandbox/workspaceRuntime.js';
import constants from '../src/config/constants.js';
import { resolveDeliverySelection } from '../src/utils/deliverySelection.js';
import { systemItem, userItem } from '../src/ai/responsesItems.js';
import { ensureWorkspace } from '../src/sandbox/workspaceFs.js';
import { getWorkspaceMetaDir } from '../src/utils/workspaceId.js';
import { sweepHistoryStore, getUserHistoryPaths, HISTORY_RETENTION_MS } from '../src/utils/historySync.js';

const realFetch = globalThis.fetch;

function handlerContext(t, platform = constants.PLATFORM_DISCORD) {
  const id = `handler-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const ctx = {
    platform, userId: id, chatId: `thread-${id}`, waJid: `${id}@c.us`,
    content: 'hello', history: [], isGroup: false,
    userIdentity: { isActiveMember: true, isAdmin: true, isLegal: false, member: null, taskFileId: id }
  };
  t.after(() => fs.rmSync(getWorkspaceMetaDir(resolveWorkspaceId(ctx)), { recursive: true, force: true }));
  return ctx;
}

function completedResponse(items = [MESSAGE_ITEM]) {
  return { response: { status: 'completed', output: items } };
}

/** An SSE body carrying the events a real round produces. */
function sseBody(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

const MESSAGE_ITEM = {
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '{"response":"done"}' }]
};
const CALL_ITEM = {
  type: 'function_call',
  call_id: 'call_1',
  name: 'read_file',
  arguments: '{"path":"workspace/a.txt"}'
};

function stubStream(items, assertRequest = null) {
  globalThis.fetch = async (_url, request) => {
    assertRequest?.(request);
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: sseBody([
        ...items.map((item, i) => ({ type: 'response.output_item.done', output_index: i, item })),
        { type: 'response.completed', response: { status: 'completed', output: [], usage: { total_tokens: 7 } } }
      ])
    };
  };
}

/** A transport whose credentials are a fixed fake — no store, no network auth. */
function fakeTransport() {
  return new OpenAIResponsesTransport({
    credentialProvider: {
      get: async () => ({
        accessToken: 'test-token',
        baseUrl: 'https://example.invalid/v1',
        accountId: null
      }),
      markStatus() {}
    },
    baseUrl: 'https://example.invalid/v1',
    extensions: null,
    label: 'test'
  });
}

beforeEach(() => { _resetProviderClientForTests(); });
afterEach(() => { globalThis.fetch = realFetch; _resetProviderClientForTests(); });

// -- transport → callAI -------------------------------------------------------

test('callAI reads the assembled response, not the envelope around it', async () => {
  stubStream([MESSAGE_ITEM], request => {
    assert.equal(request.headers.Authorization, 'Bearer test-token');
  });
  _setTransportForTests(fakeTransport());
  const { reply } = await callAI([systemItem('rules'), userItem('hi')]);

  // The transport answers `{response, requestId, usage}`. Handing that whole
  // object to the protocol reader yields an empty turn on every single call —
  // the bot would answer nothing, forever, and every suite would still pass.
  assert.equal(reply.text, '{"response":"done"}');
  assert.equal(reply.items.length, 1);
});

test('a tool call survives the seam with the shape the loop reads', async () => {
  stubStream([CALL_ITEM, MESSAGE_ITEM]);
  _setTransportForTests(fakeTransport());
  const { reply } = await callAI([userItem('open it')]);

  assert.equal(reply.toolCalls.length, 1);
  // {id, name, arguments} is what the tool-round planner and loop
  // destructure; a nested `function` object here would silently break both.
  assert.deepEqual(reply.toolCalls[0], {
    id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"workspace/a.txt"}'
  });
  assert.ok(reply.items.some((i) => i.type === 'function_call'), 'replayed for the next round');
});

test('an empty round is reported as empty, not as a crash', async () => {
  stubStream([]);
  _setTransportForTests(fakeTransport());
  const { reply } = await callAI([userItem('hi')]);
  assert.equal(reply.text, '');
  assert.deepEqual(reply.toolCalls, []);
});

// -- final reply → delivery ---------------------------------------------------

test('a workspace path in the final reply resolves to a real file', async () => {
  const workspaceId = `user:test_agent_loop_${process.pid}`;
  const root = ensureWorkspace(workspaceId);
  fs.writeFileSync(path.join(root, 'report.txt'), 'content');

  try {
    // The handler passes its own workspaceId here. Passing anything else — a
    // context object, say — makes every local path resolve to "missing" and the
    // model can never deliver a file it just made.
    const { attachments, missing } = resolveDeliverySelection(['workspace/report.txt'], workspaceId);
    assert.deepEqual(missing, []);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, 'report.txt');

    const wrong = resolveDeliverySelection(['workspace/report.txt'], { researchStats: null });
    assert.equal(wrong.attachments.length, 0, 'a non-workspaceId must not silently resolve');
  } finally {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test('the real handler consumes a structured reply through the provider seam', async () => {
  const userId = `agent-loop-handler-${process.pid}-${Date.now()}`;
  stubStream([MESSAGE_ITEM]);
  _setTransportForTests(fakeTransport());
  try {
    const result = await handleMessage({
      platform: constants.PLATFORM_DISCORD,
      userId,
      chatId: `thread-${userId}`,
      content: 'hello',
      history: [],
      isGroup: false,
      userIdentity: {
        isActiveMember: true,
        isAdmin: false,
        isLegal: false,
        member: null,
        taskFileId: `dc_${userId}`
      }
    });
    assert.equal(result.text, 'done');
  } finally {
    fs.rmSync(getWorkspaceMetaDir(`user:thread-${userId}`), { recursive: true, force: true });
  }
});

test('handler maintenance awaits subscription persistence before returning', async t => {
  const ctx = handlerContext(t);
  ctx.userIdentity.isAdmin = false;
  ctx.content = '/updates please';
  const order = [];
  _setTransportForTests({ createResponse() { assert.fail('maintenance must stop normal admission'); } });
  const result = await handleMessage(ctx, { maintenance: {
    maintenanceMode: true,
    adminOnly: true,
    async enableReleaseNotify() {
      await Promise.resolve();
      order.push('persisted');
      return { success: true };
    },
    async sendWhatsAppDirect() { order.push('mirrored'); }
  } });
  order.push('returned');
  assert.deepEqual(order, ['persisted', 'mirrored', 'returned']);
  assert.match(result.text, /aggiornamento/);
});

test('handler reaches a tool-free wrap-up using the reserved budget after work expires', async t => {
  const ctx = handlerContext(t);
  const phases = [];
  _setTransportForTests({ async createResponse({ budget, context, body }) {
    phases.push(context.phase);
    if (context.phase === 'work') {
      budget.deadlineAt = Date.now() - 1;
      throw new TransportError(TRANSPORT_ERROR.TIMEOUT, 'work deadline');
    }
    assert.equal(budget.expired, false);
    assert.equal(body.tool_choice, 'none');
    return completedResponse();
  } });
  assert.equal((await handleMessage(ctx)).text, 'done');
  assert.deepEqual(phases, ['work', 'wrap_up']);
});

for (const kind of [TRANSPORT_ERROR.AUTH, TRANSPORT_ERROR.QUOTA, TRANSPORT_ERROR.RATE_LIMIT]) {
  test(`handler preserves ${kind} from forced wrap-up`, async t => {
    const ctx = handlerContext(t);
    const refusal = new TransportError(kind, 'provider refusal');
    _setTransportForTests({ async createResponse({ budget, context }) {
      if (context.phase === 'work') {
        budget.deadlineAt = Date.now() - 1;
        throw new TransportError(TRANSPORT_ERROR.TIMEOUT, 'work deadline');
      }
      throw refusal;
    } });
    const result = await handleMessage(ctx);
    assert.equal(result.text, providerFailureReply(refusal, resolveProviderProfile()).text);
  });
}

test('a credential refusal at the deadline is not replaced by a wrap-up call', async t => {
  const ctx = handlerContext(t);
  const refusal = new TransportError(TRANSPORT_ERROR.AUTH, 'credentials rejected');
  let calls = 0;
  _setTransportForTests({ async createResponse({ budget }) {
    calls++;
    budget.deadlineAt = Date.now() - 1;
    throw refusal;
  } });
  const result = await handleMessage(ctx);
  assert.equal(calls, 1);
  assert.equal(result.text, providerFailureReply(refusal, resolveProviderProfile()).text);
});

test('handler never dispatches an unfinished function call from a partial stream', async t => {
  const ctx = handlerContext(t);
  const exec = t.mock.method(workspaceRuntime, 'execInWorkspace', () => assert.fail('partial tool was executed'));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true, status: 200, headers: new Map([['content-type', 'text/event-stream']]),
      body: sseBody([{ type: 'response.output_item.added', output_index: 0, item: {
        type: 'function_call', id: 'partial', call_id: 'partial', name: 'shell', arguments: '{"command":"echo wrong"}'
      } }])
    };
  };
  _setTransportForTests(fakeTransport());
  const result = await handleMessage(ctx);
  assert.equal(result.systemMessage, true);
  assert.equal(calls, 1);
  assert.equal(exec.mock.callCount(), 0);
});

test('manage_preferences changes the next turn, while all rounds retain admitted settings', async t => {
  const ctx = handlerContext(t, constants.PLATFORM_WA_DEDICATED);
  const settingsId = resolveSettingsFileId(ctx, ctx.userIdentity);
  t.after(() => fs.rmSync(path.join(constants.DATA_DIR, 'memories', `${settingsId}.json`), { force: true }));
  const efforts = resolveProviderProfile().supportedEfforts;
  const initialEffort = efforts[0];
  const nextEffort = efforts[efforts.length - 1];
  await updateSettings(settingsId, { effort: initialEffort, voice: 'male' });
  const seenEfforts = [];
  _setTransportForTests({ async createResponse({ body }) {
    seenEfforts.push(body.reasoning.effort);
    if (seenEfforts.length === 1) return completedResponse([{
      type: 'function_call', call_id: 'preferences', name: 'manage_preferences',
      arguments: JSON.stringify({ effort: nextEffort, voice: 'female' })
    }]);
    return completedResponse();
  } });
  assert.equal((await handleMessage(ctx)).text, 'done');
  assert.deepEqual(seenEfforts, [initialEffort, initialEffort]);
  assert.equal(ctx.settings.voice, 'male');
  assert.equal(readSettings(settingsId).voice, 'female');
  assert.equal((await handleMessage(ctx)).text, 'done');
  assert.equal(seenEfforts[2], nextEffort);
  assert.equal(ctx.settings.voice, 'female');
});

// -- history retention -------------------------------------------------------

test('the history store keeps what is in use and drops only what aged out', async () => {
  const userId = `test_history_sweep_${process.pid}`;
  const { historyDir } = getUserHistoryPaths(userId);
  fs.mkdirSync(historyDir, { recursive: true });

  const fresh = path.join(historyDir, 'photo.jpg');
  const stale = path.join(historyDir, 'old.pdf');
  fs.writeFileSync(fresh, 'a');
  fs.writeFileSync(stale, 'b');
  const longAgo = new Date(Date.now() - HISTORY_RETENTION_MS - 60_000);
  fs.utimesSync(stale, longAgo, longAgo);

  try {
    const res = await sweepHistoryStore(userId);
    // The turn that referenced them is long out of the 30-message window; that
    // is not a reason to delete anything; retention is based on age and reuse.
    assert.equal(fs.existsSync(fresh), true, 'a recently used file stays');
    assert.equal(fs.existsSync(stale), false, 'only age removes a file');
    assert.equal(res.deletedCount, 1);
    assert.equal(res.kept, 1);
  } finally {
    fs.rmSync(path.dirname(historyDir), { recursive: true, force: true });
  }
});

test('the sweep leaves a store it cannot read alone', async () => {
  const res = await sweepHistoryStore(`test_missing_${process.pid}_${Math.random().toString(36).slice(2)}`);
  assert.deepEqual(res, { deletedCount: 0, kept: 0 });
  assert.deepEqual(await sweepHistoryStore(''), { deletedCount: 0, kept: 0 });
});
