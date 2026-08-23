// src/ai/credentials/nativeCodexCredentialProvider.js
//
// The ChatGPT/Codex credential, native to GemiX.
//
// The one thing it adds over the xAI provider is `ChatGPT-Account-ID`: the
// backend routes on it, and it belongs to the account, not to the request — so
// it rides in the credential's own headers rather than being threaded through
// the transport.
//
// The endpoint behind this credential is undocumented and can change without
// notice. That fragility is a property of the backend, not of the auth, and it
// is the reason the profile treats it as a Responses endpoint and nothing more.

import envConfig from '../../config/env.js';
import { NativeOAuthCredentialProvider } from './nativeOAuthCredentialProvider.js';
import { CREDENTIAL_POOL } from './oauthProviders.js';

/**
 * @param {object} [opts] - { fetchImpl } for tests
 * @returns {NativeOAuthCredentialProvider}
 */
function createCodexCredentialProvider(opts = {}) {
  return new NativeOAuthCredentialProvider({
    pool: CREDENTIAL_POOL.CHATGPT,
    defaultBaseUrl: envConfig.CHATGPT_BASE_URL,
    extraHeaders: (account) => (account.accountId ? { 'ChatGPT-Account-ID': account.accountId } : {}),
    fetchImpl: opts.fetchImpl
  });
}

export { createCodexCredentialProvider };
