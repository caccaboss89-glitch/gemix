// src/ai/credentials/xaiServiceCredentials.js
//
// The xAI credential for the endpoints that are not the Responses main brain:
// Grok Imagine image/video and xAI TTS.
//
// It resolves through the same shared CredentialProvider the main brain uses,
// so a refresh triggered by a media call is the same rotation the next model
// call will see — and a single-use refresh token can never be spent twice.
//
// This module replaced the old auth-file reader. There is no `active_provider`
// selection and no external CLI: an expired token is refreshed here, in-process,
// before the request goes out.

import { xaiCredentialProvider } from './credentialRegistry.js';

/** Refresh when less than this is left, so a media call cannot straddle expiry. */
const MIN_REMAINING_MS = 2 * 60 * 1000;

/**
 * Current xAI service credentials.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] - after the provider rejected the token
 * @returns {Promise<{ token: string, baseUrl: string, accountId: string|null }>}
 */
async function getXaiServiceAuth(opts = {}) {
  const provider = xaiCredentialProvider();
  const credential = opts.forceRefresh
    ? await provider.refresh({ minRemainingMs: MIN_REMAINING_MS })
    : await provider.get({ minRemainingMs: MIN_REMAINING_MS });
  return {
    token: credential.accessToken,
    baseUrl: credential.baseUrl,
    accountId: credential.accountId || null
  };
}

/** Record the outcome of an xAI service call on the shared pool. */
function markXaiServiceStatus(status, accountId = null) {
  xaiCredentialProvider().markStatus(status, accountId);
}

export { getXaiServiceAuth, markXaiServiceStatus };
