import assert from 'node:assert/strict';
import test from 'node:test';

import { WhatsAppPresence } from '../src/utils/presence.js';

test('presence timeout returns while the underlying SDK call is still pending', async () => {
  let settle;
  const sdkCall = new Promise(resolve => { settle = resolve; });
  const presence = new WhatsAppPresence(
    { sendStateTyping: () => sdkCall },
    { updateTimeoutMs: 10, refreshIntervalMs: 60_000 }
  );

  const startedAt = Date.now();
  await presence.start('typing');
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(presence._isRefreshing, true);

  settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(presence._isRefreshing, false);
  await presence.stop();
});
