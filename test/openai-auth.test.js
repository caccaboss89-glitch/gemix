// test/openai-auth.test.js
//
// Phase 2: the credential store must key off the pool the caller names, never
// off `active_provider`, and must hand back the access token and the ChatGPT
// account id as one atomic pair.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { seedEnv, writeAuthFile } from './helpers/testEnv.js';

/** Far enough out to be usable, close enough to test the pre-flight window. */
const EXPIRES_IN_5_MIN = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);

const AUTH_FILE = writeAuthFile({
  // Deliberately points at the other pool: it must not influence anything.
  activeProvider: 'openai-codex',
  xai: [{ access_token: 'xai-token', base_url: 'https://api.x.ai/v1' }],
  openai: [{ access_token: 'openai-token', account_id: 'acct_live', expires_at: EXPIRES_IN_5_MIN }]
});
seedEnv({ XAI_AUTH_FILE: AUTH_FILE, OPENAI_AUTH_FILE: AUTH_FILE });

const { readPoolCredential, invalidateAuthFileCache } = await import('../src/config/hermesCredentialStore.js');
const { getOpenAiAuth, describeOpenAiAuthSource } = await import('../src/config/openaiAuth.js');
const { getXaiAuth, describeXaiAuthSource } = await import('../src/config/xaiAuth.js');

test('each profile reads its own pool, ignoring active_provider', () => {
  assert.equal(getXaiAuth().token, 'xai-token');
  assert.equal(getOpenAiAuth().accessToken, 'openai-token');
});

test('OpenAI credentials come back as one atomic token/account pair', () => {
  const auth = getOpenAiAuth();
  assert.equal(auth.accessToken, 'openai-token');
  assert.equal(auth.chatgptAccountId, 'acct_live');
});

test('auth source descriptions name the pool and file, never a credential', () => {
  for (const described of [describeOpenAiAuthSource(), describeXaiAuthSource()]) {
    assert.ok(described.includes(AUTH_FILE));
    assert.ok(!described.includes('openai-token'));
    assert.ok(!described.includes('xai-token'));
  }
});

test('entries without an account id are skipped when one is required', () => {
  const file = writeAuthFile({
    openai: [
      { access_token: 'no-account' },
      { access_token: 'complete', account_id: 'acct_2' }
    ]
  });
  const cred = readPoolCredential({ authFile: file, pool: 'openai-codex', requireAccountId: true });
  assert.equal(cred.accessToken, 'complete');
  assert.equal(cred.accountId, 'acct_2');
});

test('expired entries are skipped and a fully expired pool throws', () => {
  const past = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
  const future = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
  const file = writeAuthFile({
    openai: [
      { access_token: 'stale', account_id: 'acct_old', expires_at: past },
      { access_token: 'fresh', account_id: 'acct_new', expires_at: future }
    ]
  });
  assert.equal(readPoolCredential({ authFile: file, pool: 'openai-codex', requireAccountId: true }).accessToken, 'fresh');

  const allStale = writeAuthFile({
    openai: [{ access_token: 'stale', account_id: 'acct_old', expires_at: past }]
  });
  assert.throws(
    () => readPoolCredential({ authFile: allStale, pool: 'openai-codex', requireAccountId: true }),
    /No usable credential/
  );
});

test('failed entries rank below healthy ones', () => {
  const file = writeAuthFile({
    openai: [
      { access_token: 'failing', account_id: 'a', last_status: 'error' },
      { access_token: 'healthy', account_id: 'b' }
    ]
  });
  assert.equal(readPoolCredential({ authFile: file, pool: 'openai-codex' }).accessToken, 'healthy');
});

test('a missing pool is an explicit error, not a fallback to another pool', () => {
  const file = writeAuthFile({ openai: [] });
  assert.throws(
    () => readPoolCredential({ authFile: file, pool: 'openai-codex' }),
    /No credentials for Hermes pool "openai-codex"/
  );
});

test('a rewritten auth file is picked up on the next read', () => {
  const file = writeAuthFile({ openai: [{ access_token: 'first', account_id: 'a' }] });
  assert.equal(readPoolCredential({ authFile: file, pool: 'openai-codex' }).accessToken, 'first');

  fs.writeFileSync(file, JSON.stringify({
    credential_pool: { 'openai-codex': [{ access_token: 'rotated', account_id: 'a' }] }
  }));
  invalidateAuthFileCache(file);
  assert.equal(readPoolCredential({ authFile: file, pool: 'openai-codex' }).accessToken, 'rotated');
});

test('a token expiring inside the operation window is refused up front', () => {
  // Usable right now...
  assert.equal(getOpenAiAuth().accessToken, 'openai-token');
  // ...but not worth starting a ten-minute operation on.
  assert.throws(
    () => getOpenAiAuth({ minRemainingMs: 10 * 60 * 1000 }),
    (err) => err.code === 'OPENAI_CREDENTIAL_EXPIRING'
  );
});

test('a token inside the expiry skew is treated as already expired', () => {
  const almostGone = Math.floor((Date.now() + 30_000) / 1000);
  const file = writeAuthFile({
    openai: [{ access_token: 'about-to-die', account_id: 'a', expires_at: almostGone }]
  });
  assert.throws(
    () => readPoolCredential({ authFile: file, pool: 'openai-codex', requireAccountId: true }),
    /No usable credential/
  );
});
