// test/openai-transport.test.js
//
// Phase 3: the Codex HTTP transport — what actually goes on the wire, how
// failures are typed, and the exact retry rules.
//
// The invariant this file exists to protect: an automatic retry is only ever
// allowed before the first meaningful event. Once the model has emitted an item
// it may already have run a tool with external effects, so a truncated stream is
// a partial response, never something to replay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';
import { installFetchStub, sseResponse } from './helpers/fetchStub.js';

const AUTH_FILE = writeAuthFile({
  openai: [{ access_token: 'openai-fixture-token', account_id: 'acct_fixture' }]
});
seedEnv({
  XAI_AUTH_FILE: AUTH_FILE,
  OPENAI_AUTH_FILE: AUTH_FILE,
  // Hermes must be unreachable: the AUTH test asserts the recovery is attempted
  // once and then gives up, and nothing here may spawn a real CLI.
  HERMES_BIN: 'gemix-hermes-does-not-exist'
});

const {
  OPENAI_ERROR,
  TurnBudget,
  callCodexResponses,
  classifyHttpFailure,
  retryAfterMs,
  summarizeErrorBody
} = await import('../src/ai/openaiResponsesTransport.js');

const DONE_STREAM = [
  'event: response.output_item.done\n',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"{\\"response\\":\\"ok\\"}"}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"total_tokens":42}}}\n\n',
  'data: [DONE]\n\n'
];

const BODY = { model: 'gpt-5.6-sol', reasoning: { effort: 'max' }, store: false, stream: true, input: [] };

/** Run one call against a stubbed fetch, always disposing the budget. */
async function withStub(handler, fn, totalMs = 30_000) {
  const stub = installFetchStub(handler);
  const budget = new TurnBudget(totalMs);
  try {
    return await fn(budget, stub);
  } finally {
    budget.dispose();
    stub.restore();
  }
}

/** Assert a call rejects with a given typed provider error. */
async function expectKind(promise, kind) {
  const err = await promise.then(() => null, e => e);
  assert.ok(err, 'expected the call to reject');
  assert.equal(err.provider, 'openai');
  assert.equal(err.kind, kind, `expected ${kind}, got ${err.kind}: ${err.message}`);
  return err;
}

// -- What goes on the wire ---------------------------------------------------

test('the request carries Codex auth and nothing from the xAI stack', async () => {
  await withStub(() => sseResponse(DONE_STREAM), async (budget, stub) => {
    const result = await callCodexResponses({ body: BODY, budget, requestId: 'gemix-1' });

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Authorization'], 'Bearer openai-fixture-token');
    assert.equal(call.headers['ChatGPT-Account-ID'], 'acct_fixture');
    assert.equal(call.headers['Content-Type'], 'application/json');

    const headerNames = Object.keys(call.headers).map(h => h.toLowerCase());
    for (const forbidden of ['x-grok-conv-id', 'x-api-key']) {
      assert.equal(headerNames.includes(forbidden), false, `${forbidden} must not be sent`);
    }
    // The turn's own signal, so cancelling the turn cancels the request.
    assert.equal(call.signal, budget.signal);

    assert.deepEqual(JSON.parse(call.body), BODY);
    assert.equal(result.response.status, 'completed');
    assert.equal(result.response.output.length, 1);
    assert.equal(result.usage.total_tokens, 42);
  });
});

test('a non-SSE 200 is a malformed response, not a reply', async () => {
  await withStub(
    () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    (budget) => expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.MALFORMED_RESPONSE)
  );
});

test('the upstream request id is captured for correlation', async () => {
  await withStub(
    () => sseResponse(DONE_STREAM, { headers: { 'x-request-id': 'req_fixture_9' } }),
    async (budget) => {
      const result = await callCodexResponses({ body: BODY, budget });
      assert.equal(result.requestId, 'req_fixture_9');
    }
  );
});

// -- Failure typing ----------------------------------------------------------

test('HTTP statuses map to the typed error categories', () => {
  assert.equal(classifyHttpFailure(401, ''), OPENAI_ERROR.AUTH);
  assert.equal(classifyHttpFailure(403, 'forbidden'), OPENAI_ERROR.AUTH);
  assert.equal(classifyHttpFailure(403, 'plan does not allow this'), OPENAI_ERROR.SUBSCRIPTION_LIMIT);
  assert.equal(classifyHttpFailure(429, 'slow down'), OPENAI_ERROR.RATE_LIMIT);
  assert.equal(classifyHttpFailure(429, '{"code":"insufficient_quota"}'), OPENAI_ERROR.SUBSCRIPTION_LIMIT);
  assert.equal(classifyHttpFailure(400, ''), OPENAI_ERROR.UNSUPPORTED_INPUT);
  assert.equal(classifyHttpFailure(415, ''), OPENAI_ERROR.UNSUPPORTED_INPUT);
  assert.equal(classifyHttpFailure(503, ''), OPENAI_ERROR.TRANSIENT);
  assert.equal(classifyHttpFailure(418, ''), OPENAI_ERROR.MALFORMED_RESPONSE);
});

test('error bodies are summarized without leaking the payload', () => {
  assert.equal(summarizeErrorBody('{"error":{"message":"bad request"}}'), 'bad request');
  assert.equal(summarizeErrorBody('<!DOCTYPE html><html>...'), 'html error page');
  assert.equal(summarizeErrorBody('x'.repeat(500)).length, 300);
  assert.equal(summarizeErrorBody(''), '');
});

test('Retry-After accepts seconds and dates and never exceeds the budget', () => {
  const headers = (value) => new Headers(value === null ? {} : { 'retry-after': value });
  assert.equal(retryAfterMs(headers(null), 10_000), null);
  assert.equal(retryAfterMs(headers('2'), 10_000), 2000);
  assert.equal(retryAfterMs(headers('60'), 5000), 5000);
  assert.equal(retryAfterMs(headers('0'), 10_000), 0);
  assert.equal(retryAfterMs(headers('not a date'), 10_000), null);
  const soon = new Date(Date.now() + 3000).toUTCString();
  assert.ok(retryAfterMs(headers(soon), 10_000) > 0);
  // A date already in the past means "retry now", not "wait forever".
  assert.equal(retryAfterMs(headers(new Date(Date.now() - 5000).toUTCString()), 10_000), 0);
});

test('a 400 is not retried: the request itself is the problem', async () => {
  await withStub(
    () => new Response('{"error":{"message":"unsupported input"}}', { status: 400 }),
    async (budget, stub) => {
      await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.UNSUPPORTED_INPUT);
      assert.equal(stub.calls.length, 1);
    }
  );
});

test('a 403 about the plan is a subscription limit, not an auth failure', async () => {
  await withStub(
    () => new Response('{"error":{"message":"your plan does not include this"}}', { status: 403 }),
    async (budget, stub) => {
      await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.SUBSCRIPTION_LIMIT);
      assert.equal(stub.calls.length, 1, 'a subscription limit must not trigger the auth recovery');
    }
  );
});

test('a 401 triggers exactly one Hermes recovery and then gives up', async () => {
  await withStub(
    () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    async (budget, stub) => {
      const err = await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.AUTH);
      assert.equal(err.status, 401);
      // Hermes is unreachable here, so the recovery fails and the loop stops
      // instead of hammering the backend with the same dead token.
      assert.equal(stub.calls.length, 1);
    }
  );
});

test('a 429 with Retry-After is retried within the budget', async () => {
  let seen = 0;
  await withStub(
    () => {
      seen++;
      return seen === 1
        ? new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } })
        : sseResponse(DONE_STREAM);
    },
    async (budget, stub) => {
      const result = await callCodexResponses({ body: BODY, budget });
      assert.equal(stub.calls.length, 2);
      assert.equal(result.response.status, 'completed');
    }
  );
});

test('a Retry-After longer than the remaining budget stops the turn', async () => {
  await withStub(
    () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '3600' } }),
    async (budget, stub) => {
      await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.RATE_LIMIT);
      assert.equal(stub.calls.length, 1, 'waiting past the deadline is pointless');
    },
    3000
  );
});

test('5xx is retried up to the cold-attempt cap and then reported', async () => {
  await withStub(
    () => new Response('upstream exploded', { status: 502, headers: { 'retry-after': '0' } }),
    async (budget, stub) => {
      await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.TRANSIENT);
      assert.equal(stub.calls.length, 3);
    }
  );
});

test('a connection error before any byte is replayed', async () => {
  let seen = 0;
  await withStub(
    () => {
      seen++;
      if (seen === 1) throw new TypeError('fetch failed');
      return sseResponse(DONE_STREAM);
    },
    async (budget, stub) => {
      const result = await callCodexResponses({ body: BODY, budget });
      assert.equal(stub.calls.length, 2);
      assert.equal(result.response.status, 'completed');
    }
  );
});

// -- Streams that end badly --------------------------------------------------

test('a stream that dies after an item is partial and is never replayed', async () => {
  await withStub(
    () => new Response(new ReadableStream({
      pending: [DONE_STREAM[0] + DONE_STREAM[1]],
      // Delivered on demand: erroring a stream drops whatever is still queued,
      // and this test needs the item to reach the decoder before the reset.
      pull(controller) {
        if (this.pending.length > 0) controller.enqueue(new TextEncoder().encode(this.pending.shift()));
        else controller.error(new Error('connection reset'));
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    async (budget, stub) => {
      const err = await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.MALFORMED_RESPONSE);
      assert.equal(err.partial, true);
      assert.equal(stub.calls.length, 1, 'the model may already have run a tool');
    }
  );
});

test('a stream that closes with nothing is transient and is replayed', async () => {
  let seen = 0;
  await withStub(
    () => {
      seen++;
      return seen === 1 ? sseResponse([': keep-alive\n\n']) : sseResponse(DONE_STREAM);
    },
    async (budget, stub) => {
      const result = await callCodexResponses({ body: BODY, budget });
      assert.equal(stub.calls.length, 2);
      assert.equal(result.response.status, 'completed');
    }
  );
});

test('an error event in the stream is surfaced as malformed', async () => {
  await withStub(
    () => sseResponse(['data: {"type":"error","error":{"message":"stream broke"}}\n\n']),
    (budget) => expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.MALFORMED_RESPONSE)
  );
});

test('response.failed is surfaced as malformed', async () => {
  await withStub(
    () => sseResponse(['data: {"type":"response.failed","response":{"id":"r","status":"failed"}}\n\n']),
    (budget) => expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.MALFORMED_RESPONSE)
  );
});

test('items received before an EOF without a terminator are still used', async () => {
  await withStub(
    () => sseResponse([DONE_STREAM[0], DONE_STREAM[1]]),
    async (budget) => {
      const result = await callCodexResponses({ body: BODY, budget });
      assert.equal(result.response.status, null);
      assert.equal(result.response.output.length, 1);
    }
  );
});

// -- Budget ------------------------------------------------------------------

test('an exhausted budget fails before opening a connection', async () => {
  await withStub(
    () => sseResponse(DONE_STREAM),
    async (budget, stub) => {
      await expectKind(callCodexResponses({ body: BODY, budget }), OPENAI_ERROR.TIMEOUT);
      assert.equal(stub.calls.length, 0);
    },
    0
  );
});

test('the budget aborts its signal and reports remaining time', async () => {
  const budget = new TurnBudget(50_000);
  try {
    assert.equal(budget.expired, false);
    assert.ok(budget.remainingMs > 49_000 && budget.remainingMs <= 50_000);
    assert.equal(budget.signal.aborted, false);
  } finally {
    budget.dispose();
  }

  const parent = new AbortController();
  const child = new TurnBudget(50_000, parent.signal);
  try {
    parent.abort();
    assert.equal(child.signal.aborted, true);
    assert.equal(child.expired, true);
  } finally {
    child.dispose();
  }

  const preAborted = new AbortController();
  preAborted.abort();
  const late = new TurnBudget(50_000, preAborted.signal);
  try {
    assert.equal(late.signal.aborted, true);
  } finally {
    late.dispose();
  }
});
