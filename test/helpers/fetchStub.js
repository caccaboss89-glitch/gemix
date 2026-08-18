// test/helpers/fetchStub.js
//
// Replaces globalThis.fetch for one test and records every call, so a test can
// assert the exact URL, headers and body a transport builds without a network.

/**
 * @param {(input: any, init: any, call: object) => any} handler - returns a Response
 *   (or a plain object turned into a JSON 200 response).
 * @returns {{ calls: object[], restore: () => void }}
 */
function installFetchStub(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: typeof input === 'string' ? input : String(input?.url ?? input),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
      signal: init.signal
    };
    calls.push(call);
    const result = await handler(input, init, call);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

/** Build an SSE Response body from a list of raw chunk strings. */
function sseResponse(chunks, init = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream', ...(init.headers || {}) }
  });
}

export { installFetchStub, sseResponse };
