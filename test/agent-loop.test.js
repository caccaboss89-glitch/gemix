// test/agent-loop.test.js
//
// The two seams the unit suites cannot see: transport → callAI → the handler's
// round loop, and the model's final reply → delivery.
//
// Every other suite tests one module against its own signature, which is
// exactly why a call-site shape mismatch at a seam stays invisible while all of
// them pass. These tests drive the real modules across the seam.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { OpenAIResponsesTransport } from '../src/ai/transport/openAIResponsesTransport.js';
import { callAI, _resetProviderClientForTests, _setTransportForTests } from '../src/ai/aiProvider.js';
import { resolveDeliverySelection } from '../src/utils/deliverySelection.js';
import { systemItem, userItem } from '../src/ai/responsesItems.js';
import { ensureWorkspace } from '../src/sandbox/workspaceFs.js';
import { sweepHistoryStore, getUserHistoryPaths, HISTORY_RETENTION_MS } from '../src/utils/historySync.js';

const realFetch = globalThis.fetch;

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

function stubStream(items) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/event-stream']]),
    body: sseBody([
      ...items.map((item, i) => ({ type: 'response.output_item.done', output_index: i, item })),
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { total_tokens: 7 } } }
    ])
  });
}

/** A transport whose credentials are a fixed fake — no store, no network auth. */
function fakeTransport() {
  return new OpenAIResponsesTransport({
    credentialProvider: { get: async () => ({ token: 'test-token', accountId: null }), markStatus() {} },
    baseUrl: 'https://example.invalid/v1',
    extensions: null,
    label: 'test'
  });
}

beforeEach(() => { _resetProviderClientForTests(); });
afterEach(() => { globalThis.fetch = realFetch; _resetProviderClientForTests(); });

// -- transport → callAI -------------------------------------------------------

test('callAI reads the assembled response, not the envelope around it', async () => {
  stubStream([MESSAGE_ITEM]);
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
  // {id, name, arguments} is what partitionHandlerToolCalls and the round loop
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
    const { attachments, missing } = await resolveDeliverySelection(['workspace/report.txt'], workspaceId);
    assert.deepEqual(missing, []);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].name, 'report.txt');

    const wrong = await resolveDeliverySelection(['workspace/report.txt'], { researchStats: null });
    assert.equal(wrong.attachments.length, 0, 'a non-workspaceId must not silently resolve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// -- history retention -------------------------------------------------------

test('the history store keeps what is in use and drops only what aged out', () => {
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
    const res = sweepHistoryStore(userId);
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

test('the sweep leaves a store it cannot read alone', () => {
  const res = sweepHistoryStore(`test_missing_${process.pid}_${Math.random().toString(36).slice(2)}`);
  assert.deepEqual(res, { deletedCount: 0, kept: 0 });
  assert.deepEqual(sweepHistoryStore(''), { deletedCount: 0, kept: 0 });
});
