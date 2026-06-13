// src/config/xaiAuth.js
//
// Unified xAI credentials for all direct API calls (LLM, TTS, Imagine).
// XAI_USE_API_KEY=false (default): Bearer token from ~/.hermes/auth.json
// XAI_USE_API_KEY=true: Bearer XAI_API_KEY from .env
//
// OAuth auth file shape:
//   {
//     "active_provider": "xai-oauth",
//     "credential_pool": {
//       "xai-oauth": [
//         { "access_token": "...", "base_url": "https://api.x.ai/v1", ... }
//       ]
//     }
//   }

const fs = require('fs');
const {
  XAI_USE_API_KEY,
  XAI_API_KEY,
  XAI_AUTH_FILE,
  XAI_BASE_URL,
} = require('./env');

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

let _oauthCache = null; // { mtimeMs, size, token, baseUrl }

function _pickCredential(parsed) {
  const provider = parsed.active_provider || 'xai-oauth';
  const pool = parsed.credential_pool?.[provider];
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error(`No credentials for provider "${provider}" in ${XAI_AUTH_FILE}`);
  }
  const usable = pool
    .filter(c => c && typeof c.access_token === 'string' && c.access_token.length > 0)
    .sort((a, b) => {
      const okA = !a.last_status || a.last_status === 'ok' ? 0 : 1;
      const okB = !b.last_status || b.last_status === 'ok' ? 0 : 1;
      if (okA !== okB) return okA - okB;
      return (a.priority ?? 0) - (b.priority ?? 0);
    });
  if (usable.length === 0) {
    throw new Error(`No usable access_token in ${XAI_AUTH_FILE}`);
  }
  return usable[0];
}

function _getOAuthAuth(forceReload = false) {
  let stat;
  try {
    stat = fs.statSync(XAI_AUTH_FILE);
  } catch (err) {
    throw new Error(`xAI auth file not found at ${XAI_AUTH_FILE}: ${err.message}`);
  }

  if (!forceReload && _oauthCache
    && _oauthCache.mtimeMs === stat.mtimeMs
    && _oauthCache.size === stat.size) {
    return { token: _oauthCache.token, baseUrl: _oauthCache.baseUrl };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(XAI_AUTH_FILE, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot parse xAI auth file ${XAI_AUTH_FILE}: ${err.message}`);
  }

  const cred = _pickCredential(parsed);
  const baseUrl = (typeof cred.base_url === 'string' && cred.base_url.trim()
    ? cred.base_url.trim()
    : DEFAULT_BASE_URL).replace(/\/+$/, '');

  _oauthCache = { mtimeMs: stat.mtimeMs, size: stat.size, token: cred.access_token, baseUrl };
  return { token: _oauthCache.token, baseUrl: _oauthCache.baseUrl };
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
  return `oauth file (${XAI_AUTH_FILE})`;
}

module.exports = { getXaiAuth, describeXaiAuthSource };
