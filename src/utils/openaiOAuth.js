// src/utils/openaiOAuth.js
//
// Canonical OAuth boundary for every ChatGPT/Codex HTTP caller. It selects the
// Hermes openai-codex pool, refreshes an expired or short-lived credential with
// one inexpensive "ciao" wake request, and permits one 401 refresh/retry for a
// logical operation. Callers keep the returned refresh state for the whole
// operation so retries cannot wake Hermes repeatedly.
//
// The helper is also the integration point for the image adapter: it exports
// both credential resolution and authenticated fetch without coupling them to
// Responses or Build. Neither tokens nor account ids enter errors or logs.

import {
  getOpenAiAuth,
  invalidateOpenAiAuthCache,
  OPENAI_AUTH_FILE,
  OPENAI_HERMES_POOL
} from '../config/openaiAuth.js';
import { refreshHermesOAuth } from './hermesAuthRefresh.js';

function createOpenAiOAuthState() {
  return { refreshAttempted: false };
}

function _oauthError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

function isOpenAiOAuthError(err) {
  return typeof err?.code === 'string' && err.code.startsWith('OPENAI_OAUTH_');
}

function _needsRefresh(err) {
  return err?.code === 'OPENAI_CREDENTIAL_EXPIRING'
    || err?.code === 'OPENAI_CREDENTIAL_UNAVAILABLE';
}

/**
 * Wake Hermes once, invalidate the cached parse, then require a credential
 * that still covers this operation's remaining duration.
 */
async function refreshOpenAiOAuth({
  minRemainingMs = 0,
  refreshState = createOpenAiOAuthState(),
  refresh = refreshHermesOAuth
} = {}) {
  if (refreshState.refreshAttempted) {
    throw _oauthError('OPENAI_OAUTH_REFRESH_EXHAUSTED', 'OpenAI OAuth refresh was already attempted.');
  }
  refreshState.refreshAttempted = true;

  try {
    await refresh(OPENAI_HERMES_POOL, OPENAI_AUTH_FILE, {
      requireAuthFileChange: true
    });
    invalidateOpenAiAuthCache();
    return getOpenAiAuth({ forceReload: true, minRemainingMs });
  } catch (err) {
    throw _oauthError('OPENAI_OAUTH_REFRESH_FAILED', 'OpenAI OAuth refresh failed.', err);
  }
}

/** Resolve an atomic bearer/account pair, refreshing before an unsafe start. */
async function resolveOpenAiOAuth({
  minRemainingMs = 0,
  refreshState = createOpenAiOAuthState(),
  refresh = refreshHermesOAuth
} = {}) {
  try {
    return getOpenAiAuth({ minRemainingMs });
  } catch (err) {
    if (!_needsRefresh(err)) {
      throw _oauthError('OPENAI_OAUTH_UNAVAILABLE', 'OpenAI OAuth credential is unavailable.', err);
    }
    return refreshOpenAiOAuth({ minRemainingMs, refreshState, refresh });
  }
}

/** Copy caller headers while replacing any attempted identity override. */
function buildOpenAiAuthHeaders(headers, auth) {
  const out = {};
  const source = headers instanceof Headers ? headers.entries() : Object.entries(headers || {});
  for (const [name, value] of source) {
    const lower = String(name).toLowerCase();
    if (lower === 'authorization' || lower === 'chatgpt-account-id') continue;
    out[name] = value;
  }
  out.Authorization = `Bearer ${auth.accessToken}`;
  out['ChatGPT-Account-ID'] = auth.chatgptAccountId;
  return out;
}

/**
 * Authenticated fetch with a preflight refresh and at most one 401 replay.
 * The first 401 response remains readable when refresh fails so the caller can
 * preserve its normal status/body classification.
 */
async function fetchWithOpenAiOAuth(url, init = {}, {
  minRemainingMs = 0,
  refreshState = createOpenAiOAuthState(),
  refresh = refreshHermesOAuth,
  fetchImpl = fetch
} = {}) {
  let auth = await resolveOpenAiOAuth({ minRemainingMs, refreshState, refresh });
  const run = () => fetchImpl(url, {
    ...init,
    headers: buildOpenAiAuthHeaders(init.headers, auth)
  });

  let response = await run();
  if (response.status !== 401 || refreshState.refreshAttempted) {
    return { response, retried401: false, refreshError: null, refreshState };
  }

  try {
    auth = await refreshOpenAiOAuth({ minRemainingMs, refreshState, refresh });
  } catch (refreshError) {
    return { response, retried401: false, refreshError, refreshState };
  }

  try { await response.body?.cancel(); } catch { /* the retry does not need the stale body */ }
  response = await run();
  return { response, retried401: true, refreshError: null, refreshState };
}

export {
  createOpenAiOAuthState,
  resolveOpenAiOAuth,
  refreshOpenAiOAuth,
  fetchWithOpenAiOAuth,
  buildOpenAiAuthHeaders,
  isOpenAiOAuthError
};
