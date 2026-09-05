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

test('a stream with no content-type is read, a stream with the wrong one is refused', async () => {
  // The Codex backend sends a well-formed event stream with the content-type
  // header omitted. Refusing it threw away a working response over a missing
  // label, and every turn died on the first round.
  const noHeader = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => sseResponse(COMPLETED_STREAM, { headers: { 'content-type': null } })
  });
  const { response } = await noHeader.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(response.status, 'completed');

  // A content-type that is present and says something else is real evidence
  // that the answer is not a stream, and must still be refused with the body
  // quoted: that body is usually what explains the refusal.
  const wrongHeader = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => '{"error":"nope"}'
    })
  });
  await assert.rejects(
    () => wrongHeader.createResponse({ body: { model: 'm', input: [] } }),
    /Expected an event stream, got "application\/json"/
  );
});

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

test('an account base URL overrides the profile fallback', async () => {
  let seenUrl = null;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    baseUrl: 'https://profile.test/v1',
    label: 'test',
    fetchImpl: async (url) => {
      seenUrl = url;
      return sseResponse(COMPLETED_STREAM);
    }
  });

  await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(seenUrl, 'https://api.test/v1/responses');
});

test('provider-neutral logs contain the decorated wire request and full response stream', async () => {
  const logs = { request: [], response: [] };
  const apiLogWriter = {
    request: (...args) => logs.request.push(args),
    response: (...args) => logs.response.push(args)
  };
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'chatgpt-oauth',
    extensions: {
      providerId: 'chatgpt-oauth',
      decorateBody: body => ({ ...body, provider_field: 'kept' })
    },
    apiLogWriter,
    fetchImpl: async () => sseResponse(COMPLETED_STREAM)
  });

  await transport.createResponse({
    body: { model: 'm', input: [{ role: 'user', content: 'hello' }] },
    requestId: 'gemix-1',
    context: { round: 2, phase: 'work' }
  });

  assert.equal(logs.request.length, 1);
  assert.equal(logs.response.length, 1);
  assert.equal(logs.request[0][2].provider_field, 'kept');
  assert.equal(logs.request[0][3].provider, 'chatgpt-oauth');
  assert.equal(logs.request[0][3].round, 2);
  assert.equal(logs.response[0][2].stream.events.length, 2);
  assert.equal(logs.response[0][2].assembledResponse.output[0].content[0].text, 'ok');
  assert.equal(logs.response[0][3].apiLogId, logs.request[0][3].apiLogId);
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

test('an overloaded error event is replayed cold and then succeeds', async () => {
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? sseResponse([
          'data: {"type":"error","code":"server_error",'
          + '"message":"Our servers are currently overloaded. Please try again later."}\n\n'
        ])
        : sseResponse(COMPLETED_STREAM);
    }
  });

  const { response } = await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(calls, 2);
  assert.equal(response.status, 'completed');
});

test('a rate-limit error event is replayed cold and then succeeds', async () => {
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? sseResponse([
          'data: {"type":"error","error":{"type":"rate_limit_error",'
          + '"message":"Too many requests"}}\n\n'
        ])
        : sseResponse(COMPLETED_STREAM);
    }
  });

  const { response } = await transport.createResponse({ body: { model: 'm', input: [] } });
  assert.equal(calls, 2);
  assert.equal(response.status, 'completed');
});

test('a transient stream error after output is never replayed', async () => {
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return sseResponse([
        'data: {"type":"response.output_text.delta","output_index":0,'
        + '"content_index":0,"delta":"started"}\n\n',
        'data: {"type":"error","code":"server_error","message":"Server overloaded"}\n\n'
      ]);
    }
  });

  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.TRANSIENT && err.partial === true
  );
  assert.equal(calls, 1);
});

test('an unknown stream error remains malformed and is not replayed', async () => {
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return sseResponse([
        'data: {"type":"error","code":"mystery",'
        + '"message":"Unrecognized protocol failure"}\n\n'
      ]);
    }
  });

  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === false
  );
  assert.equal(calls, 1);
});

test('delta-only EOF is a partial malformed response and is never replayed', async () => {
  const credentials = new StubCredentials();
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: credentials,
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return sseResponse([
        'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"unfinished"}\n\n'
      ]);
    }
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === true
  );
  assert.equal(calls, 1);
});

test('an added function call followed by EOF is never executable', async () => {
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => sseResponse([
      'data: {"type":"response.output_item.added","output_index":0,'
      + '"item":{"id":"fc1","type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}}\n\n'
    ])
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === true
  );
});

test('a terminal event cannot make an unfinished function call executable', async () => {
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => sseResponse([
      'data: {"type":"response.output_item.added","output_index":0,'
      + '"item":{"id":"fc1","type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n'
    ])
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === true
  );
});

test('a malformed SSE event makes the stream malformed even if later output is valid', async () => {
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => sseResponse([
      'data: not-json\n\n',
      ...COMPLETED_STREAM
    ])
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.MALFORMED && err.partial === true
  );
});

test('AbortError while reading a stream is classified as timeout', async () => {
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: (async function* () {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      })(),
      text: async () => ''
    })
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [] } }),
    err => err.kind === TRANSPORT_ERROR.TIMEOUT && err.partial === false
  );
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

test('a refused field is a hard stop, not something to retry blindly', async () => {
  let calls = 0;
  const transport = new OpenAIResponsesTransport({
    credentialProvider: new StubCredentials(),
    label: 'test',
    fetchImpl: async () => {
      calls++;
      return errorResponse(400, '{"error":{"message":"unknown parameter: include"}}');
    }
  });
  await assert.rejects(
    transport.createResponse({ body: { model: 'm', input: [], include: ['x'] } }),
    (err) => err.kind === TRANSPORT_ERROR.UNSUPPORTED_INPUT
  );
  assert.equal(calls, 1, 'the same body would be refused the same way');
});
