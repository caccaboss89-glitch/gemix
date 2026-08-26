import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import responseLock from '../src/utils/responseLock.js';

test('an expiry timer alone does not keep a Node process alive', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'import lock from "./src/utils/responseLock.js"; lock.tryLock("test", 120000);'
    ],
    { cwd: process.cwd(), encoding: 'utf-8', timeout: 1_500 }
  );

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});


test('auto-renew gives up at its ceiling instead of holding a chat for good', async () => {
  const key = 'auto-renew-ceiling';
  const ttl = 60_000;
  assert.equal(responseLock.tryLock(key, ttl), true);
  // A caller that never releases: the stop function is deliberately ignored
  // here, which is the situation the ceiling exists for.
  const stop = responseLock.startAutoRenew(key, ttl, 5);

  const realNow = Date.now;
  // Past the ceiling without touching a real clock. Renewals that still ran
  // would push the expiry to this same moment and keep the key busy.
  Date.now = () => realNow.call(Date) + 26 * 60 * 1000;
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(responseLock.tryLock(key, ttl), true);
  } finally {
    Date.now = realNow;
    stop();
    responseLock.unlock(key);
  }
});
