import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchHistoryWithTimeout } from '../src/utils/historyFetch.js';

test('history timeout aborts the builder before it can commit late work', async () => {
  let lateMutation = false;
  let observedAbort = false;
  const warnings = [];

  const result = await fetchHistoryWithTimeout(async (signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    observedAbort = signal.aborted;
    signal.throwIfAborted();
    lateMutation = true;
    return [];
  }, { warn: message => warnings.push(message) }, 'TEST', { timeoutMs: 5 });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(result, { history: [], incomplete: true });
  assert.equal(observedAbort, true);
  assert.equal(lateMutation, false);
  assert.match(warnings[0], /History fetch timeout/);
});
