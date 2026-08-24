// src/ai/credentials/oauthClient.js
//
// A standard OAuth 2.0 client: authorization code with PKCE over a loopback
// redirect, plus the refresh-token grant. Provider-neutral — every endpoint,
// client id and scope arrives in a descriptor (see oauthProviders.js).
//
// This is what replaced waking an external CLI to have it refresh a file for
// us. A refresh here is one HTTPS round trip that finishes in well under a
// second, spends no subscription quota, and needs nothing installed on the host.
//
// Two rules the implementations must not lose:
//   - the refresh token is single-use, so the rotated pair the response carries
//     is the only one that will work next time;
//   - nothing in here logs a token, a code, a verifier or a client secret.

import crypto from 'crypto';
import http from 'http';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('OAuth');

/** How long the loopback login waits for the browser to come back. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Token endpoint timeout: a refresh that takes longer than this is broken. */
const TOKEN_TIMEOUT_MS = 30 * 1000;

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A PKCE verifier/challenge pair (S256).
 * @returns {{ verifier: string, challenge: string }}
 */
function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * The URL the operator opens in a browser.
 *
 * @param {object} descriptor - from oauthProviders.js
 * @param {object} opts
 * @param {string} opts.challenge - PKCE S256 challenge
 * @param {string} opts.state
 * @param {string} opts.redirectUri
 * @returns {string}
 */
function buildAuthorizeUrl(descriptor, { challenge, state, redirectUri }) {
  const url = new URL(descriptor.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', descriptor.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', descriptor.scope);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(descriptor.extraAuthorizeParams || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Read a token response into the store's shape. Throws on an error payload. */
function _readTokenResponse(payload, previousRefreshToken) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('the token endpoint returned something that is not an object');
  }
  if (payload.error) {
    const detail = payload.error_description || payload.error;
    throw new Error(`the token endpoint refused the request (${detail})`);
  }
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('the token response carried no access_token');
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken,
    // A response without a new refresh token means the old one still stands;
    // one WITH a new token means the old one is already dead.
    refreshToken: typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : (previousRefreshToken || null),
    expiresAtMs: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    idToken: typeof payload.id_token === 'string' ? payload.id_token : null
  };
}

async function _postForm(url, form, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  });

  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* reported below */ }

  if (!res.ok) {
    const detail = payload?.error_description || payload?.error || text.slice(0, 200);
    throw new Error(`token endpoint HTTP ${res.status}: ${detail}`);
  }
  return payload;
}

/**
 * Exchange an authorization code for the first token pair.
 *
 * @param {object} descriptor
 * @param {object} opts - { code, verifier, redirectUri, fetchImpl? }
 * @returns {Promise<{accessToken, refreshToken, expiresAtMs, idToken}>}
 */
async function exchangeAuthorizationCode(descriptor, { code, verifier, redirectUri, fetchImpl }) {
  const payload = await _postForm(descriptor.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: descriptor.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  }, { fetchImpl });
  return _readTokenResponse(payload, null);
}

/**
 * Swap a single-use refresh token for a fresh pair.
 *
 * @param {object} descriptor
 * @param {string} refreshToken
 * @param {object} [opts]
 * @returns {Promise<{accessToken, refreshToken, expiresAtMs, idToken}>}
 */
async function refreshAccessToken(descriptor, refreshToken, { fetchImpl } = {}) {
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('no refresh token stored for this account');
  }
  const form = {
    grant_type: 'refresh_token',
    client_id: descriptor.clientId,
    refresh_token: refreshToken
  };
  if (descriptor.scope && descriptor.sendScopeOnRefresh) form.scope = descriptor.scope;
  const payload = await _postForm(descriptor.tokenUrl, form, { fetchImpl });
  return _readTokenResponse(payload, refreshToken);
}

/**
 * Run the interactive login: start a loopback listener, print the URL to open,
 * and resolve once the provider redirects back with a matching state.
 *
 * @param {object} descriptor
 * @param {object} [opts]
 * @param {(url: string) => void} [opts.onAuthorizeUrl] - where to show the URL
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{accessToken, refreshToken, expiresAtMs, idToken}>}
 */
async function loopbackLogin(descriptor, opts = {}) {
  const { verifier, challenge } = createPkcePair();
  const state = base64url(crypto.randomBytes(24));
  const redirectUri = descriptor.redirectUri;
  const port = Number(new URL(redirectUri).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`the redirect URI "${redirectUri}" must name a loopback port`);
  }

  const authorizeUrl = buildAuthorizeUrl(descriptor, { challenge, state, redirectUri });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let requestUrl;
      try {
        requestUrl = new URL(req.url, redirectUri);
      } catch {
        res.writeHead(400).end('Bad request');
        return;
      }
      if (requestUrl.pathname !== new URL(redirectUri).pathname) {
        res.writeHead(404).end('Not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      const returnedCode = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`Login failed: ${error}`);
        finish(new Error(`the provider refused the login (${error})`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Login failed: state mismatch');
        finish(new Error('the redirect carried a state that does not match this login attempt'));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Login failed: no authorization code');
        finish(new Error('the redirect carried no authorization code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><p>GemiX is authenticated. You can close this tab.</p>');
      finish(null, returnedCode);
    });

    let settled = false;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => (err ? reject(err) : resolve(value)));
    }

    const timer = setTimeout(
      () => finish(new Error(`login timed out after ${Math.round((opts.timeoutMs || LOGIN_TIMEOUT_MS) / 1000)}s`)),
      opts.timeoutMs || LOGIN_TIMEOUT_MS
    );

    server.on('error', (err) => finish(new Error(`cannot listen on ${redirectUri}: ${err.message}`)));
    server.listen(port, '127.0.0.1', () => {
      if (typeof opts.onAuthorizeUrl === 'function') opts.onAuthorizeUrl(authorizeUrl);
      else log.info(`Open this URL to authorize GemiX:\n${authorizeUrl}`);
    });
  });

  return exchangeAuthorizationCode(descriptor, { code, verifier, redirectUri, fetchImpl: opts.fetchImpl });
}

export {
  createPkcePair,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  loopbackLogin
};
