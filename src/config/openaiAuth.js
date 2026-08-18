// src/config/openaiAuth.js
//
// Credentials for the ChatGPT/Codex profile: the Hermes `openai-codex` pool,
// read through the shared credential store so the pool is named explicitly and
// `active_provider` never decides anything.
//
// Every call returns the access token and the ChatGPT account id together, as
// one atomic pair — the backend rejects a request whose bearer and
// `ChatGPT-Account-ID` come from different entries.
//
// Neither value is ever logged, put in an error message, written to a file or
// passed to a child process by this module. Callers that need to describe the
// credential use describeOpenAiAuthSource(), which only names the file.

import envConfig from './env.js';
import { readPoolCredential, invalidateAuthFileCache } from './hermesCredentialStore.js';

const AUTH_FILE = envConfig.OPENAI_AUTH_FILE;
const POOL = 'openai-codex';

/**
 * Current OpenAI credentials.
 * @param {object} [opts]
 * @param {boolean} [opts.forceReload] - re-read the file (after a refresh or a 401)
 * @param {number} [opts.minRemainingMs] - reject a token that would expire inside
 *   this window, so a long operation is not started on a credential about to die
 * @returns {{ accessToken: string, chatgptAccountId: string, expiresAtMs: number|null }}
 */
function getOpenAiAuth({ forceReload = false, minRemainingMs = 0 } = {}) {
  const cred = readPoolCredential({
    authFile: AUTH_FILE,
    pool: POOL,
    requireAccountId: true,
    forceReload
  });

  if (minRemainingMs > 0 && cred.expiresAtMs !== null) {
    if (cred.expiresAtMs - Date.now() < minRemainingMs) {
      const err = new Error('OpenAI credential expires before this operation could finish.');
      err.code = 'OPENAI_CREDENTIAL_EXPIRING';
      throw err;
    }
  }

  return {
    accessToken: cred.accessToken,
    chatgptAccountId: cred.accountId,
    expiresAtMs: cred.expiresAtMs
  };
}

/** Forget the cached parse so the next read picks up a refreshed file. */
function invalidateOpenAiAuthCache() {
  invalidateAuthFileCache(AUTH_FILE);
}

/** Human-readable source for startup logs. Never includes a credential. */
function describeOpenAiAuthSource() {
  return `hermes pool "${POOL}" (${AUTH_FILE})`;
}

export {
  getOpenAiAuth,
  invalidateOpenAiAuthCache,
  describeOpenAiAuthSource,
  AUTH_FILE as OPENAI_AUTH_FILE,
  POOL as OPENAI_HERMES_POOL
};
