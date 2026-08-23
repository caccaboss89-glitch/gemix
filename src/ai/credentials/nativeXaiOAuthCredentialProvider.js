// src/ai/credentials/nativeXaiOAuthCredentialProvider.js
//
// The xAI credential, native to GemiX: own store, own PKCE login, own refresh.
// No external CLI is invoked at runtime or at bootstrap, and no `active_provider`
// selects the pool implicitly — this provider names it.
//
// xAI sends no per-account header of its own, so the credential carries only the
// bearer; the base URL comes from the account when it stored one, otherwise from
// the profile.

import envConfig from '../../config/env.js';
import { NativeOAuthCredentialProvider } from './nativeOAuthCredentialProvider.js';
import { CREDENTIAL_POOL } from './oauthProviders.js';

/**
 * @param {object} [opts] - { fetchImpl } for tests
 * @returns {NativeOAuthCredentialProvider}
 */
function createXaiCredentialProvider(opts = {}) {
  return new NativeOAuthCredentialProvider({
    pool: CREDENTIAL_POOL.XAI,
    defaultBaseUrl: envConfig.XAI_BASE_URL,
    fetchImpl: opts.fetchImpl
  });
}

export { createXaiCredentialProvider };
