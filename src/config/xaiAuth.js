// src/config/xaiAuth.js
//
// Unified xAI credentials for all direct API calls (LLM, TTS, Imagine).
// XAI_USE_API_KEY=false (default): Bearer token from ~/.hermes/auth.json
// XAI_USE_API_KEY=true: Bearer XAI_API_KEY from .env
//
// OAuth auth file shape:
//   {
//     "active_provider": "…",            // ignored: see below
//     "credential_pool": {
//       "xai-oauth": [
//         { "access_token": "...", "base_url": "https://api.x.ai/v1", ... }
//       ]
//     }
//   }
//
// The pool is always "xai-oauth". `active_provider` only records which provider
// the Hermes CLI last used, so following it could hand an unrelated provider's
// token to api.x.ai after any other Hermes invocation.

import envConfig from './env.js';
import { readPoolCredential, invalidateAuthFileCache } from './hermesCredentialStore.js';

const {
  XAI_USE_API_KEY,
  XAI_API_KEY,
  XAI_AUTH_FILE,
  XAI_BASE_URL
} = envConfig;

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const POOL = 'xai-oauth';

function _getOAuthAuth(forceReload = false) {
  const cred = readPoolCredential({
    authFile: XAI_AUTH_FILE,
    pool: POOL,
    forceReload
  });
  return { token: cred.accessToken, baseUrl: cred.baseUrl || DEFAULT_BASE_URL };
}

/**
 * Current xAI credentials (token + base URL).
 * OAuth file is re-read when it changes on disk or after HTTP 401.
 *
 * @param {boolean} [forceReload] - Bypass OAuth mtime cache (used after HTTP 401).
 * @returns {{ token: string, baseUrl: string }}
 */
function getXaiAuth(forceReload = false) {
  if (XAI_USE_API_KEY) {
    return { token: XAI_API_KEY, baseUrl: XAI_BASE_URL };
  }
  return _getOAuthAuth(forceReload);
}

/** Human-readable label for startup logs. */
function describeXaiAuthSource() {
  if (XAI_USE_API_KEY) {
    return `api_key (${XAI_BASE_URL})`;
  }
  return `hermes pool "${POOL}" (${XAI_AUTH_FILE})`;
}

/** Forget the cached parse so the next read picks up a refreshed file. */
function invalidateXaiAuthCache() {
  invalidateAuthFileCache(XAI_AUTH_FILE);
}

export { getXaiAuth, describeXaiAuthSource, invalidateXaiAuthCache, POOL as XAI_HERMES_POOL
};
