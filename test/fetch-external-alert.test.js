import assert from 'node:assert/strict';
import test from 'node:test';

import { withAdminNotificationPolicy } from '../src/utils/adminNotifier.js';
import { fetchExternal } from '../src/utils/fetch.js';

async function _captureFailure(fetchImpl) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await assert.rejects(
      withAdminNotificationPolicy(
        { suppress: true, reason: 'test' },
        () => fetchExternal('https://service.example/test', {}, 'External Test', 1000)
      ),
      (err) => {
        const notes = err.message.match(/\[Admin notification:/g) || [];
        assert.equal(notes.length, 1, 'the model-facing alert note must appear exactly once');
        assert.doesNotMatch(err.message, /Tell the user the admin has been notified/i);
        assert.match(err.message, /suppressed for this turn/i);
        return true;
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('fetchExternal reports a non-ok response once with one truthful note', async () => {
  let calls = 0;
  await _captureFailure(async () => {
    calls++;
    return { ok: false, status: 503 };
  });
  assert.equal(calls, 1);
});

test('fetchExternal reports a network exception once with one truthful note', async () => {
  let calls = 0;
  await _captureFailure(async () => {
    calls++;
    throw new Error('network down');
  });
  assert.equal(calls, 1);
});
