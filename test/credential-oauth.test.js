// test/credential-oauth.test.js
//
// The OAuth half: PKCE S256, the authorize URL, and the refresh grant's
// single-use rotation contract.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken
} from '../src/ai/credentials/oauthClient.js';
import { CREDENTIAL_POOL, isDescriptorConfigured, oauthDescriptorFor } from '../src/ai/credentials/oauthProviders.js';

const DESCRIPTOR = Object.freeze({
  provider: 'test',
  clientId: 'client-123',
  authorizeUrl: 'https://auth.example/oauth/authorize',
  tokenUrl: 'https://auth.example/oauth/token',
  scope: 'openid offline_access',
  redirectUri: 'http://127.0.0.1:8976/callback',
  sendScopeOnRefresh: false,
  clientIdEnvVar: 'TEST_OAUTH_CLIENT_ID'
});

/** A fetch stand-in that records the form it was posted. */
function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(options.body)) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload)
    };
  };
  impl.calls = calls;
  return impl;
}

test('createPkcePair produces a verifier whose S256 hash is the challenge', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('createPkcePair never repeats a verifier', () => {
  const seen = new Set(Array.from({ length: 20 }, () => createPkcePair().verifier));
  assert.equal(seen.size, 20);
});

test('buildAuthorizeUrl carries S256, the state and the loopback redirect', () => {
  const url = new URL(buildAuthorizeUrl(DESCRIPTOR, {
    challenge: 'the-challenge',
    state: 'the-state',
    redirectUri: DESCRIPTOR.redirectUri
  }));
  assert.equal(url.origin + url.pathname, 'https://auth.example/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('code_challenge'), 'the-challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'the-state');
  assert.equal(url.searchParams.get('redirect_uri'), DESCRIPTOR.redirectUri);
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('the code exchange sends the verifier and no client secret', async () => {
  const fetchImpl = stubFetch({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
  const tokens = await exchangeAuthorizationCode(DESCRIPTOR, {
    code: 'the-code',
    verifier: 'the-verifier',
    redirectUri: DESCRIPTOR.redirectUri,
    fetchImpl
  });
  assert.equal(fetchImpl.calls[0].form.grant_type, 'authorization_code');
  assert.equal(fetchImpl.calls[0].form.code_verifier, 'the-verifier');
  assert.equal(fetchImpl.calls[0].form.client_secret, undefined);
  assert.equal(tokens.accessToken, 'a1');
  assert.equal(tokens.refreshToken, 'r1');
  assert.ok(tokens.expiresAtMs > Date.now());
});

test('a refresh adopts the rotated refresh token', async () => {
  const fetchImpl = stubFetch({ access_token: 'a2', refresh_token: 'r2', expires_in: 60 });
  const tokens = await refreshAccessToken(DESCRIPTOR, 'r1', { fetchImpl });
  assert.equal(fetchImpl.calls[0].form.grant_type, 'refresh_token');
  assert.equal(fetchImpl.calls[0].form.refresh_token, 'r1');
  assert.equal(tokens.refreshToken, 'r2');
});

test('a refresh response without a new refresh token keeps the old one', async () => {
  const tokens = await refreshAccessToken(DESCRIPTOR, 'r1', {
    fetchImpl: stubFetch({ access_token: 'a3', expires_in: 60 })
  });
  assert.equal(tokens.refreshToken, 'r1');
});

test('scope is only sent on refresh when the descriptor asks for it', async () => {
  const plain = stubFetch({ access_token: 'a', expires_in: 60 });
  await refreshAccessToken(DESCRIPTOR, 'r', { fetchImpl: plain });
  assert.equal(plain.calls[0].form.scope, undefined);

  const scoped = stubFetch({ access_token: 'a', expires_in: 60 });
  await refreshAccessToken({ ...DESCRIPTOR, sendScopeOnRefresh: true }, 'r', { fetchImpl: scoped });
  assert.equal(scoped.calls[0].form.scope, DESCRIPTOR.scope);
});

test('a missing refresh token fails before any request goes out', async () => {
  const fetchImpl = stubFetch({});
  await assert.rejects(
    () => refreshAccessToken(DESCRIPTOR, null, { fetchImpl }),
    /no refresh token stored/
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('an error payload on a 200 is still an error', async () => {
  await assert.rejects(
    () => refreshAccessToken(DESCRIPTOR, 'r', {
      fetchImpl: stubFetch({ error: 'invalid_grant', error_description: 'token expired' })
    }),
    /token expired/
  );
});

test('a non-2xx token response reports the status', async () => {
  await assert.rejects(
    () => refreshAccessToken(DESCRIPTOR, 'r', {
      fetchImpl: stubFetch({ error: 'invalid_client' }, { status: 401 })
    }),
    /HTTP 401/
  );
});

test('the chatgpt descriptor ships configured; xai names the missing variables', () => {
  const chatgpt = oauthDescriptorFor(CREDENTIAL_POOL.CHATGPT);
  assert.equal(isDescriptorConfigured(chatgpt).ok, true);
  assert.equal(chatgpt.redirectUri.startsWith('http://localhost:'), true);

  const xai = oauthDescriptorFor(CREDENTIAL_POOL.XAI);
  const configured = isDescriptorConfigured(xai);
  if (!configured.ok) {
    assert.match(configured.reason, /XAI_OAUTH_CLIENT_ID|XAI_OAUTH_AUTHORIZE_URL|XAI_OAUTH_TOKEN_URL/);
  }
});

test('an unknown pool has no descriptor', () => {
  assert.throws(() => oauthDescriptorFor('gemini'), /No OAuth descriptor/);
});
