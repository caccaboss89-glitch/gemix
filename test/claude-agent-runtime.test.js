// test/claude-agent-runtime.test.js
//
// The Claude Agent runtime's local contracts: the Claude Code process sees an
// allowlisted environment with the subscription token as its only credential,
// and concurrent turns queue behind a bounded semaphore.

import assert from 'node:assert/strict';
import test from 'node:test';
import envConfig from '../src/config/env.js';
import { claudeCodeEnv } from '../src/ai/claudeAgent/claudeCode.js';
import { createSemaphore } from '../src/utils/concurrency.js';

test('the Claude Code environment carries the subscription token and nothing else secret', () => {
  const env = claudeCodeEnv({ configDir: '/gemix/claude/config', oauthToken: 'subscription-token' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-token');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/gemix/claude/config');
  assert.equal(Object.keys(env).some(key => key.startsWith('ANTHROPIC_')), false);
  const own = new Set([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
    'DISABLE_AUTOUPDATER',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
  ]);
  for (const key of Object.keys(env)) {
    assert.ok(own.has(key) || key in envConfig.SUBPROCESS_BASE_ENV, `${key} is not allowlisted`);
  }
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in claudeCodeEnv({ configDir: '/c' }), false);
});

test('the semaphore hands slots over in arrival order and releases once per holder', async () => {
  const semaphore = createSemaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  const order = [];
  const third = semaphore.acquire().then(release => { order.push('third'); return release; });
  const fourth = semaphore.acquire().then(release => { order.push('fourth'); return release; });
  assert.equal(semaphore.waiting, 2);

  first();
  first();
  const releaseThird = await third;
  assert.deepEqual(order, ['third']);
  assert.equal(semaphore.active, 2);
  assert.equal(semaphore.waiting, 1);

  second();
  (await fourth)();
  releaseThird();
  assert.deepEqual(order, ['third', 'fourth']);
  assert.equal(semaphore.active, 0);
});

test('a waiter whose signal aborts leaves the queue without taking a slot', async () => {
  const semaphore = createSemaphore(1);
  const holder = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort(new Error('turn deadline'));
  await assert.rejects(waiting, /turn deadline/);
  assert.equal(semaphore.waiting, 0);
  holder();
  assert.equal(semaphore.active, 0);
  await assert.rejects(semaphore.acquire(controller.signal), /turn deadline/);
});
