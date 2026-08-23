// test/credential-store.test.js
//
// The store's three guarantees: a read-modify-write cannot lose a concurrent
// one, a rotated pair reaches disk atomically, and pool order puts a usable,
// healthy account first.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  orderPool,
  patchAccount,
  readPool,
  removeAccount,
  storePath,
  updatePool,
  upsertAccount
} from '../src/ai/credentials/credentialStore.js';

/** Unique per run so a parallel test file cannot collide with this one. */
const POOL = `test-store-${process.pid}`;

after(() => {
  try { fs.unlinkSync(storePath(POOL)); } catch { /* never created */ }
});

function account(id, extra = {}) {
  return { id, accessToken: `access-${id}`, refreshToken: `refresh-${id}`, ...extra };
}

test('readPool treats a missing store as an empty pool', () => {
  assert.deepEqual(readPool(`${POOL}-absent`), []);
});

test('upsertAccount round-trips through the store and replaces by id', async () => {
  await upsertAccount(POOL, account('one', { label: 'first' }));
  await upsertAccount(POOL, account('two'));
  assert.deepEqual(readPool(POOL).map(a => a.id), ['one', 'two']);

  await upsertAccount(POOL, account('one', { label: 'renamed' }));
  const pool = readPool(POOL);
  assert.equal(pool.length, 2);
  assert.equal(pool.find(a => a.id === 'one').label, 'renamed');
});

test('the store file never keeps its temp file around', () => {
  assert.equal(fs.existsSync(`${storePath(POOL)}.tmp`), false);
});

test('patchAccount touches only the named account', async () => {
  await patchAccount(POOL, 'two', { lastStatus: 'quota', lastStatusAt: 1234 });
  const pool = readPool(POOL);
  assert.equal(pool.find(a => a.id === 'two').lastStatus, 'quota');
  assert.equal(pool.find(a => a.id === 'one').lastStatus, 'ok');
});

test('concurrent updates serialize instead of losing one another', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => updatePool(POOL, (accounts) => [
      ...accounts,
      { id: `concurrent-${i}`, accessToken: `t${i}`, refreshToken: null }
    ]))
  );
  const ids = readPool(POOL).map(a => a.id);
  for (let i = 0; i < 8; i++) assert.ok(ids.includes(`concurrent-${i}`), `lost concurrent-${i}`);
});

test('removeAccount drops exactly one account', async () => {
  const remaining = await removeAccount(POOL, 'concurrent-0');
  assert.equal(remaining.some(a => a.id === 'concurrent-0'), false);
  assert.equal(remaining.some(a => a.id === 'concurrent-1'), true);
});

test('a malformed store reads as empty rather than throwing', () => {
  const brokenPool = `${POOL}-broken`;
  const file = storePath(brokenPool);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  try {
    assert.deepEqual(readPool(brokenPool), []);
  } finally {
    fs.unlinkSync(file);
  }
});

test('an account with no token at all is dropped on read', async () => {
  const emptyPool = `${POOL}-empty`;
  await updatePool(emptyPool, () => [
    { id: 'ghost', accessToken: '', refreshToken: null },
    { id: 'real', accessToken: 'live', refreshToken: null }
  ]);
  try {
    assert.deepEqual(readPool(emptyPool).map(a => a.id), ['real']);
  } finally {
    fs.unlinkSync(storePath(emptyPool));
  }
});

test('orderPool puts healthy before unhealthy and usable before unusable', () => {
  const now = 1_000_000;
  const ordered = orderPool([
    { id: 'expired-no-refresh', accessToken: 'a', refreshToken: null, expiresAtMs: now - 1, priority: 0, lastStatus: 'ok' },
    { id: 'failed', accessToken: 'b', refreshToken: 'r', expiresAtMs: null, priority: 1, lastStatus: 'auth_failed' },
    { id: 'healthy-low-priority', accessToken: 'c', refreshToken: 'r', expiresAtMs: null, priority: 5, lastStatus: 'ok' },
    { id: 'healthy-first', accessToken: 'd', refreshToken: 'r', expiresAtMs: null, priority: 2, lastStatus: 'ok' }
  ], now);
  assert.deepEqual(ordered.map(a => a.id), [
    'healthy-first',
    'healthy-low-priority',
    'failed',
    'expired-no-refresh'
  ]);
});

test('an unexpired account without a refresh token still counts as usable', () => {
  const now = 1_000_000;
  const ordered = orderPool([
    { id: 'refreshable-failed', accessToken: 'a', refreshToken: 'r', expiresAtMs: null, priority: 9, lastStatus: 'error' },
    { id: 'live-api-key', accessToken: 'b', refreshToken: null, expiresAtMs: now + 60_000, priority: 1, lastStatus: 'ok' }
  ], now);
  assert.deepEqual(ordered.map(a => a.id), ['live-api-key', 'refreshable-failed']);
});
