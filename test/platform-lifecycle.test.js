import assert from 'node:assert/strict';
import test from 'node:test';

import { loginDiscordWithRetry } from '../src/platforms/discord/client.js';
import { withPromiseTimeout } from '../src/utils/promiseTimeout.js';

test('promise timeout settles even when the underlying lifecycle call never does', async () => {
  await assert.rejects(
    withPromiseTimeout(new Promise(() => {}), 10, 'stuck lifecycle'),
    error => error.code === 'ETIMEOUT'
  );
});

test('Discord login retries transient failures and eventually becomes ready', async () => {
  let attempts = 0;
  const result = await loginDiscordWithRetry({
    async login() {
      attempts++;
      if (attempts < 3) throw new Error('gateway unavailable');
      return 'token';
    }
  }, 'token', {
    maxAttempts: 4,
    timeoutMs: 100,
    sleep: async () => {}
  });
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
});

test('Discord login reports exhaustion instead of silently disabling itself', async () => {
  let attempts = 0;
  await assert.rejects(loginDiscordWithRetry({
    async login() { attempts++; throw new Error('bad token'); }
  }, 'token', {
    maxAttempts: 3,
    timeoutMs: 100,
    sleep: async () => {}
  }), /failed after 3 attempts/);
  assert.equal(attempts, 3);
});
