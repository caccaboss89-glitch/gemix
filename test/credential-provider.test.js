// test/credential-provider.test.js
//
// The runtime half of native auth: refresh before expiry rather than after a
// rejection, one exchange for concurrent callers, the rotated pair on disk
// before it is handed out, and rotation to the next account when a login dies.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after } from 'node:test';
import {
  NativeOAuthCredentialProvider,
  PROACTIVE_REFRESH_MS
} from '../src/ai/credentials/nativeOAuthCredentialProvider.js';
import { readPool, storePath, updatePool } from '../src/ai/credentials/credentialStore.js';
import { extractAccounts } from '../src/ai/credentials/credentialImport.js';

const DESCRIPTOR = Object.freeze({
  provider: 'test',
  clientId: 'client-123',
  authorizeUrl: 'https://auth.example/oauth/authorize',
  tokenUrl: 'https://auth.example/oauth/token',
  scope: 'offline_access',
  redirectUri: 'http://127.0.0.1:8976/callback',
  sendScopeOnRefresh: false,
  clientIdEnvVar: 'TEST_OAUTH_CLIENT_ID'
});

/** A provider on a throwaway pool with a descriptor that needs no .env. */
class TestProvider extends NativeOAuthCredentialProvider {
  get _descriptor() {
    return DESCRIPTOR;
  }
}

const pools = new Set();

function poolName(name) {
  const pool = `test-provider-${process.pid}-${name}`;
  pools.add(pool);
  return pool;
}

after(() => {
  for (const pool of pools) {
    try { fs.unlinkSync(storePath(pool)); } catch { /* never created */ }
  }
});

/** A token endpoint that hands out a fresh pair and counts its calls. */
function tokenEndpoint({ expiresIn = 3600, fail = false } = {}) {
  let n = 0;
  const impl = async () => {
    n++;
    impl.calls = n;
    if (fail) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        expires_in: expiresIn
      })
    };
  };
  impl.calls = 0;
  return impl;
}

/** First exchange fails, the next one succeeds: exercises pool failover. */
function failThenSucceedEndpoint() {
  let n = 0;
  const impl = async () => {
    n++;
    impl.calls = n;
    if (n === 1) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        expires_in: 3600
      })
    };
  };
  impl.calls = 0;
  return impl;
}

test('a token far from expiry is handed over without a refresh', async () => {
  const pool = poolName('fresh');
  await updatePool(pool, () => [{
    id: 'a',
    accessToken: 'stored',
    refreshToken: 'r',
    expiresAtMs: Date.now() + PROACTIVE_REFRESH_MS + 60_000,
    priority: 0,
    lastStatus: 'ok'
  }]);
  const fetchImpl = tokenEndpoint();
  const provider = new TestProvider({ pool, defaultBaseUrl: 'https://api.example/v1', fetchImpl });

  const credential = await provider.get();
  assert.equal(credential.accessToken, 'stored');
  assert.equal(credential.baseUrl, 'https://api.example/v1');
  assert.equal(fetchImpl.calls, 0);
});

test('a token inside the proactive window is refreshed before the call', async () => {
  const pool = poolName('proactive');
  await updatePool(pool, () => [{
    id: 'a',
    accessToken: 'stale',
    refreshToken: 'r0',
    expiresAtMs: Date.now() + PROACTIVE_REFRESH_MS - 60_000,
    priority: 0,
    lastStatus: 'ok'
  }]);
  const fetchImpl = tokenEndpoint();
  const provider = new TestProvider({ pool, fetchImpl });

  const credential = await provider.get();
  assert.equal(credential.accessToken, 'access-1');
  assert.equal(fetchImpl.calls, 1);
});

test('the rotated pair is on disk before the credential is returned', async () => {
  const pool = poolName('persist');
  await updatePool(pool, () => [{
    id: 'a', accessToken: 'stale', refreshToken: 'r0', expiresAtMs: Date.now() + 1000, priority: 0, lastStatus: 'ok'
  }]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint() });

  const credential = await provider.get();
  const stored = readPool(pool)[0];
  assert.equal(stored.accessToken, credential.accessToken);
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.notEqual(stored.refreshToken, 'r0');
});

test('concurrent callers share one refresh, so a single-use token is spent once', async () => {
  const pool = poolName('single-flight');
  await updatePool(pool, () => [{
    id: 'a', accessToken: 'stale', refreshToken: 'r0', expiresAtMs: Date.now() + 1000, priority: 0, lastStatus: 'ok'
  }]);
  const fetchImpl = tokenEndpoint();
  const provider = new TestProvider({ pool, fetchImpl });

  const credentials = await Promise.all([provider.get(), provider.get(), provider.get()]);
  assert.equal(fetchImpl.calls, 1);
  assert.deepEqual(new Set(credentials.map(c => c.accessToken)), new Set(['access-1']));
});

test('a refresh that fails rotates to the next account and marks the dead one', async () => {
  const pool = poolName('rotate');
  await updatePool(pool, () => [
    { id: 'dead', accessToken: 'expired', refreshToken: 'r0', expiresAtMs: Date.now() - 1000, priority: 0, lastStatus: 'ok' },
    { id: 'spare', accessToken: 'spare-token', refreshToken: 'r1', expiresAtMs: null, priority: 1, lastStatus: 'ok' }
  ]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint({ fail: true }) });

  const credential = await provider.get();
  assert.equal(credential.accessToken, 'spare-token');
  assert.equal(credential.accountId, 'spare');
  assert.equal(readPool(pool).find(a => a.id === 'dead').lastStatus, 'auth_failed');
});

test('an expired spare is refreshed before failover returns it', async () => {
  const pool = poolName('rotate-refresh-spare');
  await updatePool(pool, () => [
    { id: 'dead', accessToken: 'expired-a', refreshToken: 'r0', expiresAtMs: Date.now() - 2000, priority: 0, lastStatus: 'ok' },
    { id: 'spare', accessToken: 'expired-b', refreshToken: 'r1', expiresAtMs: Date.now() - 1000, priority: 1, lastStatus: 'ok' }
  ]);
  const fetchImpl = failThenSucceedEndpoint();
  const provider = new TestProvider({ pool, fetchImpl });

  const credential = await provider.get();
  assert.equal(credential.accountId, 'spare');
  assert.equal(credential.accessToken, 'access-2');
  assert.equal(fetchImpl.calls, 2);
  assert.equal(readPool(pool).find(a => a.id === 'spare').accessToken, 'access-2');
});

test('a failed refresh on the last usable account surfaces the error', async () => {
  const pool = poolName('no-spare');
  await updatePool(pool, () => [{
    id: 'only', accessToken: 'expired', refreshToken: 'r0', expiresAtMs: Date.now() - 1000, priority: 0, lastStatus: 'ok'
  }]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint({ fail: true }) });
  await assert.rejects(() => provider.get(), /invalid_grant|HTTP 400/);
});

test('a live token survives a broken refresh instead of rotating away', async () => {
  const pool = poolName('still-valid');
  await updatePool(pool, () => [
    { id: 'a', accessToken: 'live', refreshToken: 'r0', expiresAtMs: Date.now() + 60_000, priority: 0, lastStatus: 'ok' },
    { id: 'b', accessToken: 'other', refreshToken: 'r1', expiresAtMs: null, priority: 1, lastStatus: 'ok' }
  ]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint({ fail: true }) });

  const credential = await provider.get();
  assert.equal(credential.accessToken, 'live');
  assert.equal(readPool(pool).find(a => a.id === 'a').lastStatus, 'ok');
});

test('a broken refresh never returns a token shorter than the requested lifetime', async () => {
  const pool = poolName('minimum-lifetime');
  await updatePool(pool, () => [
    { id: 'short', accessToken: 'short-live', refreshToken: 'r0', expiresAtMs: Date.now() + 60_000, priority: 0, lastStatus: 'ok' },
    { id: 'spare', accessToken: 'spare-live', refreshToken: 'r1', expiresAtMs: null, priority: 1, lastStatus: 'ok' }
  ]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint({ fail: true }) });

  const credential = await provider.get({ minRemainingMs: 120_000 });
  assert.equal(credential.accountId, 'spare');
  assert.equal(credential.accessToken, 'spare-live');
});

test('refresh() forces an exchange even on a token that looks fine', async () => {
  const pool = poolName('forced');
  await updatePool(pool, () => [{
    id: 'a',
    accessToken: 'stored',
    refreshToken: 'r0',
    expiresAtMs: Date.now() + PROACTIVE_REFRESH_MS + 60_000,
    priority: 0,
    lastStatus: 'ok'
  }]);
  const fetchImpl = tokenEndpoint();
  const provider = new TestProvider({ pool, fetchImpl });

  const credential = await provider.refresh();
  assert.equal(credential.accessToken, 'access-1');
  assert.equal(fetchImpl.calls, 1);
});

test('refresh targets the account rejected by the transport', async () => {
  const pool = poolName('forced-account');
  await updatePool(pool, () => [
    { id: 'a', accessToken: 'a-live', refreshToken: 'ra', expiresAtMs: null, priority: 0, lastStatus: 'ok' },
    { id: 'b', accessToken: 'b-live', refreshToken: 'rb', expiresAtMs: null, priority: 1, lastStatus: 'ok' }
  ]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint() });
  await provider.get();

  const credential = await provider.refresh({ accountId: 'b' });
  assert.equal(credential.accountId, 'b');
  assert.equal(credential.accessToken, 'access-1');
  assert.equal(readPool(pool).find(a => a.id === 'a').accessToken, 'a-live');
});

test('markStatus records a change and skips a repeat', async () => {
  const pool = poolName('status');
  await updatePool(pool, () => [{
    id: 'a', accessToken: 'live', refreshToken: 'r', expiresAtMs: null, priority: 0, lastStatus: 'ok'
  }]);
  const provider = new TestProvider({ pool, fetchImpl: tokenEndpoint() });
  await provider.get();

  await provider.markStatus('quota');
  const marked = readPool(pool)[0];
  assert.equal(marked.lastStatus, 'quota');
  assert.ok(Number.isFinite(marked.lastStatusAt));

  await provider.markStatus('quota');
  assert.equal(readPool(pool)[0].lastStatusAt, marked.lastStatusAt);
});

test('an empty pool tells the operator which command to run', async () => {
  const provider = new TestProvider({ pool: poolName('empty') });
  await assert.rejects(() => provider.get(), /npm run auth -- login/);
});

test('a per-account baseUrl overrides the profile default', async () => {
  const pool = poolName('base-url');
  await updatePool(pool, () => [{
    id: 'a', accessToken: 'live', refreshToken: 'r', expiresAtMs: null, baseUrl: 'https://tenant.example/v1', priority: 0, lastStatus: 'ok'
  }]);
  const provider = new TestProvider({ pool, defaultBaseUrl: 'https://api.example/v1', fetchImpl: tokenEndpoint() });
  assert.equal((await provider.get()).baseUrl, 'https://tenant.example/v1');
});

test('extraHeaders reach the credential', async () => {
  const pool = poolName('headers');
  await updatePool(pool, () => [{
    id: 'a', accessToken: 'live', refreshToken: 'r', expiresAtMs: null, accountId: 'acct-9', priority: 0, lastStatus: 'ok'
  }]);
  const provider = new TestProvider({
    pool,
    fetchImpl: tokenEndpoint(),
    extraHeaders: (account) => (account.accountId ? { 'ChatGPT-Account-ID': account.accountId } : {})
  });
  assert.deepEqual((await provider.get()).headers, { 'ChatGPT-Account-ID': 'acct-9' });
});

// -- import shapes ------------------------------------------------------------

test('a bare token object imports as one account', () => {
  const accounts = extractAccounts({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 'xai');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accessToken, 'a');
  assert.equal(accounts[0].refreshToken, 'r');
  assert.ok(accounts[0].expiresAtMs > Date.now());
});

test('a Codex-shaped file keeps the routing account id next to the tokens', () => {
  const accounts = extractAccounts({
    tokens: { access_token: 'a', refresh_token: 'r' },
    account_id: 'acct-42'
  }, 'chatgpt');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, 'acct-42');
});

test('a credential pool is read by name, never through active_provider', () => {
  const accounts = extractAccounts({
    active_provider: 'openai-codex',
    credential_pool: {
      'xai-oauth': [
        { access_token: 'x1', refresh_token: 'r1' },
        { access_token: 'x2', refresh_token: 'r2' }
      ],
      'openai-codex': [{ access_token: 'o1', refresh_token: 'ro1' }]
    }
  }, 'xai');
  assert.deepEqual(accounts.map(a => a.accessToken), ['x1', 'x2']);
});

test('an explicit pool key wins over the name match', () => {
  const accounts = extractAccounts({
    credential_pool: {
      'xai-oauth': [{ access_token: 'x1', refresh_token: 'r1' }],
      'xai-legacy': [{ access_token: 'x9', refresh_token: 'r9' }]
    }
  }, 'xai', 'xai-legacy');
  assert.deepEqual(accounts.map(a => a.accessToken), ['x9']);
});

test('an entry with neither token is not imported', () => {
  assert.deepEqual(extractAccounts({ token_type: 'Bearer' }, 'xai'), []);
});

test('seconds-based and ISO expiries both normalize to milliseconds', () => {
  const seconds = extractAccounts({ access_token: 'a', expires_at: 1_800_000_000 }, 'xai')[0];
  assert.equal(seconds.expiresAtMs, 1_800_000_000_000);
  const iso = extractAccounts({ access_token: 'a', expires_at: '2030-01-01T00:00:00Z' }, 'xai')[0];
  assert.equal(iso.expiresAtMs, Date.parse('2030-01-01T00:00:00Z'));
});
