// src/ai/credentials/oauthProviders.js
//
// Where each provider's OAuth endpoints, client id and scope come from.
//
// They are public values — the client ids belong to the vendors' own
// open-source CLIs, not to GemiX — but they are still deployment data, so they
// live in .env and are only defaulted where the value is part of a published,
// stable CLI. A descriptor with no client id configured is not an error at
// boot: it only stops `npm run auth -- login <provider>` with a message that
// says which variable to fill.
//
// Nothing here is a secret: PKCE exists precisely so a public client needs no
// client secret, and GemiX never sends one.

import envConfig from '../../config/env.js';

/**
 * @typedef {object} OAuthDescriptor
 * @property {string} provider - pool name in the credential store
 * @property {string} clientId
 * @property {string} authorizeUrl
 * @property {string} tokenUrl
 * @property {string} scope
 * @property {string} redirectUri - loopback, port fixed by the provider's allowlist
 * @property {boolean} sendScopeOnRefresh
 * @property {object} [extraAuthorizeParams]
 * @property {string} clientIdEnvVar - named in the "not configured" message
 */

/** Pool names. They are also the credential-store filenames. */
const CREDENTIAL_POOL = Object.freeze({
  XAI: 'xai',
  CHATGPT: 'chatgpt'
});

function _xaiDescriptor() {
  return {
    provider: CREDENTIAL_POOL.XAI,
    clientId: envConfig.XAI_OAUTH_CLIENT_ID,
    authorizeUrl: envConfig.XAI_OAUTH_AUTHORIZE_URL,
    tokenUrl: envConfig.XAI_OAUTH_TOKEN_URL,
    scope: envConfig.XAI_OAUTH_SCOPE,
    redirectUri: envConfig.XAI_OAUTH_REDIRECT_URI,
    sendScopeOnRefresh: false,
    clientIdEnvVar: 'XAI_OAUTH_CLIENT_ID'
  };
}

function _chatgptDescriptor() {
  return {
    provider: CREDENTIAL_POOL.CHATGPT,
    clientId: envConfig.CHATGPT_OAUTH_CLIENT_ID,
    authorizeUrl: envConfig.CHATGPT_OAUTH_AUTHORIZE_URL,
    tokenUrl: envConfig.CHATGPT_OAUTH_TOKEN_URL,
    scope: envConfig.CHATGPT_OAUTH_SCOPE,
    redirectUri: envConfig.CHATGPT_OAUTH_REDIRECT_URI,
    sendScopeOnRefresh: false,
    clientIdEnvVar: 'CHATGPT_OAUTH_CLIENT_ID'
  };
}

const DESCRIPTORS = Object.freeze({
  [CREDENTIAL_POOL.XAI]: _xaiDescriptor,
  [CREDENTIAL_POOL.CHATGPT]: _chatgptDescriptor
});

/**
 * The OAuth descriptor for a pool.
 * @param {string} pool
 * @returns {OAuthDescriptor}
 */
function oauthDescriptorFor(pool) {
  const build = DESCRIPTORS[pool];
  if (!build) {
    throw new Error(`No OAuth descriptor for "${pool}". Known pools: ${Object.keys(DESCRIPTORS).join(', ')}.`);
  }
  return Object.freeze(build());
}

/**
 * Whether the descriptor has enough configuration to run a login or a refresh.
 * @param {OAuthDescriptor} descriptor
 * @returns {{ ok: boolean, reason: string|null }}
 */
function isDescriptorConfigured(descriptor) {
  const missing = [];
  if (!descriptor.clientId) missing.push(descriptor.clientIdEnvVar);
  if (!descriptor.authorizeUrl) missing.push(`${descriptor.clientIdEnvVar.replace('_CLIENT_ID', '')}_AUTHORIZE_URL`);
  if (!descriptor.tokenUrl) missing.push(`${descriptor.clientIdEnvVar.replace('_CLIENT_ID', '')}_TOKEN_URL`);
  if (missing.length === 0) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `OAuth for "${descriptor.provider}" is not configured: set ${missing.join(', ')} in .env.`
  };
}

export { CREDENTIAL_POOL, oauthDescriptorFor, isDescriptorConfigured };
