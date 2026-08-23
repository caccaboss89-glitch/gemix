// test/transport-http.test.js
//
// The transport against an injected fetch: the retry policy, the one-shot
// credential refresh, and the guarantee that a stream which already produced
// items is never replayed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIResponsesTransport } from '../src/ai/transport/openAIResponsesTransport.js';
import { TRANSPORT_ERROR } from '../src/ai/transport/errors.js';
import { CredentialProvider } from '../src/ai/credentials/credentialProvider.js';
import { TurnBudget } from '../src/utils/turnBudget.js';

class StubCredentials extends CredentialProvider {
  constructor() {
    super({ id: 'stub' });
    this.getCalls = 0;
    this.refreshCalls = 0;
    this.statuses = [];
    this.refreshFails = false;
  }

  async get() {
    this.getCalls++;
    return { accessToken: `tok${this.refreshCalls}`, baseUrl: 'https://api.test/v1', headers: {} };
  }

  async refresh() {
    this.refreshCalls++;
    if (this.refreshFails) throw new Error('refresh unavailable');
    return this.get();
  }

  markStatus(status) {
    this.statuses.push(status);
  }
}

function sseResponse(chunks, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => ({ 'content-type': 'text/event-stream', ...headers })[String(k).toLowerCase()] ?? null
    },
    body: (async function* () {
      for (const c of chunks) yield encoder.encode(c);
    })(),
    text: async () => ''
  };
}

function errorResponse(status, body, headers = {}) {
  return {
    ok: false,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => body
  };
}

const COMPLETED_STREAM = [
  'data: {"type":"response.output_item.done","output_index":0,'
  + '"item":{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n'
];

test('a successful call assembles the stream and marks the credential healthy', async () => {
  const credentials = new StubCredentials();
  let seenUrl = null;
  let seenInit = null;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return sseResponse(COMPLETED_STREAM);
    }
  });

  const { response } = await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(seenUrl, 'https://api.test/v1/responses');
  assert.equal(seenInit.headers.Authorization, 'Bearer tok0');
  assert.equal(seenInit.headers.Accept, 'text/event-stream');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].content[0].text, 'ok');
  assert.deepEqual(credentials.statuses, ['ok']);
});

test('a 503 is replayed cold and then succeeds', async () => {
  const credentials = new StubCredentials();
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? errorResponse(503, 'upstream down') : sseResponse(COMPLETED_STREAM);
    }
  });
  const { response } = await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(calls, 2);
  assert.equal(response.status, 'completed');
});

test('a 401 triggers exactly one credential refresh, then the failure stands', async () => {
  const credentials = new StubCredentials();
  credentials.refreshFails = false;
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return errorResponse(401, 'bad token');
    }
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    (err) => err.kind === TRANSPORT_ERROR.AUTH
  );
  assert.equal(credentials.refreshCalls, 1);
  assert.ok(credentials.statuses.includes('auth_failed'));
  // First attempt, one refreshed retry, then the loop gives up on AUTH.
  assert.equal(calls, 2);
});

test('a quota refusal is not retried and is reported to the credential pool', async () => {
  const credentials = new StubCredentials();
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return errorResponse(429, '{"error":{"message":"insufficient_quota"}}');
    }
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    (err) => err.kind === TRANSPORT_ERROR.QUOTA
  );
  assert.equal(calls, 1);
  assert.ok(credentials.statuses.includes('quota'));
});

test('a stream that dies after producing an item is a partial failure, never replayed', async () => {
  const credentials = new StubCredentials();
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        body: (async function* () {
          yield new TextEncoder().encode(
            'data: {"type":"response.output_item.done","output_index":0,'
            + '"item":{"id":"fc1","type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}}\n\n'
          );
          throw new Error('socket hang up');
        })(),
        text: async () => ''
      };
    }
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    (err) => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === true
  );
  assert.equal(calls, 1);
});

test('a stream that produced nothing is replayed', async () => {
  const credentials = new StubCredentials();
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: (async function* () { /* closes with nothing */ })(),
          text: async () => ''
        };
      }
      return sseResponse(COMPLETED_STREAM);
    }
  });
  const { response } = await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(calls, 2);
  assert.equal(response.status, 'completed');
});

test('a non-SSE 200 answer is malformed, not silently parsed', async () => {
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"output":[]}'
    })
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    (err) => err.kind === TRANSPORT_ERROR.MALFORMED
  );
});

test('an expired turn budget fails as TIMEOUT without contacting the model', async () => {
  let called = false;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => { called = true; return sseResponse(COMPLETED_STREAM); }
  });
  const budget = new TurnBudget(0);
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] }, budget }),
    (err) => err.kind === TRANSPORT_ERROR.TIMEOUT
  );
  budget.dispose();
  assert.equal(called, false);
});

test('extensions decorate headers and body without touching the transport', async () => {
  let seenInit = null;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    extensions: {
      providerId: 'stubprov',
      decorateHeaders: (h, ctx) => ({ ...h, 'x-conv': ctx.promptCacheKey }),
      decorateBody: (b, ctx) => ({ ...b, prompt_cache_key: ctx.promptCacheKey })
    },
    fetchImpl: async (_url, init) => { seenInit = init; return sseResponse(COMPLETED_STREAM); }
  });
  await transport.createResponse({
    body: { model: 'm', input: [] },
    context: { promptCacheKey: 'conv-1' }
  });
  assert.equal(seenInit.headers['x-conv'], 'conv-1');
  assert.equal(JSON.parse(seenInit.body).prompt_cache_key, 'conv-1');
});

test('an extension may drop a refused optional field and retry without spending an attempt', async () => {
  let calls = 0;
  let dropped = false;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    extensions: {
      providerId: 'stubprov',
      decorateBody: (b) => (dropped ? { ...b, include: undefined } : b),
      onUnsupportedInput: (bodyText) => {
        if (!dropped && /include/i.test(bodyText)) { dropped = true; return true; }
        return false;
      }
    },
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? errorResponse(400, '{"error":{"message":"unknown parameter: include"}}')
        : sseResponse(COMPLETED_STREAM);
    }
  });
  const { response } = await transport.createResponse({ body: { model: 'm', input: [], include: ['x'] } });
  assert.equal(calls, 2);
  assert.equal(dropped, true);
  assert.equal(response.status, 'completed');
});
