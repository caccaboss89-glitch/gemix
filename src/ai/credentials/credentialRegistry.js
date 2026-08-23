// src/ai/credentials/credentialRegistry.js
//
// One CredentialProvider instance per pool, for the whole process.
//
// This is not a convenience: refresh tokens are single-use, and two instances
// of the same pool would each keep their own single-flight map. Two concurrent
// refreshes would then both spend the stored token, and the loser would persist
// a pair the provider has already invalidated. Sharing the instance is what
// makes the single-flight guarantee actually hold.
//
// The xAI factory lives here too, because the main brain and the xAI media
// endpoints (Imagine, TTS) must authenticate through the same object.

import envConfig from '../../config/env.js';
import { ApiKeyCredentialProvider } from './credentialProvider.js';
import { createXaiCredentialProvider } from './nativeXaiOAuthCredentialProvider.js';
import { CREDENTIAL_POOL } from './oauthProviders.js';

/** @type {Map<string, import('./credentialProvider.js').CredentialProvider>} */
const _instances = new Map();

/**
 * The shared provider for a key, created on first use.
 *
 * @param {string} key
 * @param {() => import('./credentialProvider.js').CredentialProvider} factory
 * @returns {import('./credentialProvider.js').CredentialProvider}
 */
function sharedCredentialProvider(key, factory) {
  if (!_instances.has(key)) _instances.set(key, factory());
  return _instances.get(key);
}

/**
 * The xAI credential, whichever way this deployment authenticates.
 *
 * A static API key needs no store and cannot be refreshed; the OAuth path uses
 * GemiX's own pool. Both the Responses main brain and the xAI media endpoints
 * resolve through this one object.
 *
 * @returns {import('./credentialProvider.js').CredentialProvider}
 */
function xaiCredentialProvider() {
  return sharedCredentialProvider(
    envConfig.XAI_USE_API_KEY ? 'xai-api-key' : CREDENTIAL_POOL.XAI,
    () => (envConfig.XAI_USE_API_KEY
      ? new ApiKeyCredentialProvider({
        id: 'xai-api-key',
        apiKey: envConfig.XAI_API_KEY,
        baseUrl: envConfig.XAI_BASE_URL
      })
      : createXaiCredentialProvider())
  );
}

/** Drop every memoized provider. Tests only. */
function _resetCredentialProvidersForTests() {
  _instances.clear();
}

export { sharedCredentialProvider, xaiCredentialProvider, _resetCredentialProvidersForTests };
