// src/media/cloudflareAccounts.js
//
// Which Cloudflare Workers AI account GemiX runs on right now.
//
// Workers AI grants each account 10,000 free neurons a day, so the deployment
// can hold several accounts and work through them one at a time on the shared
// rotation in utils/credentialRing.js. An account is a PAIR — the account id is
// in the request URL and the API token in the Authorization header — so the two
// .env lists are zipped positionally: the first id belongs to the first token.
//
// An account is written down as spent only when Cloudflare itself refuses the
// call — 401/403 (the credential is unusable) or 429 (the allowance is really
// gone, our own estimate having been optimistic). The neuron ledger refusing a
// call is not that: it means this particular call does not fit in what is left,
// and a cheaper one later today still might, so the client simply moves on to
// the next account without touching the ring.
//
// Cloudflare resets the free allowance at 00:00 UTC, which is also the day
// boundary the neuron ledger counts on, so the ring's period is the UTC day.

import path from 'path';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { createCredentialRing } from '../utils/credentialRing.js';

const ring = createCredentialRing({
  label: 'Cloudflare',
  stateFile: path.join(constants.DATA_DIR, 'cloudflare_accounts.json'),
  listCredentials: () => envConfig.CLOUDFLARE_AI_ACCOUNTS,
  identify: account => `${account.accountId}:${account.apiToken}`,
  periodKey: () => new Date().toISOString().slice(0, 10)
});

const CLOUDFLARE_STATE_FILE = ring.STATE_FILE;

/** True when this deployment has Workers AI credentials at all. */
function isCloudflareConfigured() {
  return envConfig.CLOUDFLARE_AI_ACCOUNTS.length > 0;
}

/**
 * Every account still worth trying today, in the order to try them: the one
 * that last served a call first, so the common case costs no failed request.
 * Empty when every configured account is spent (or none is configured at all).
 * @returns {Array<{ accountId: string, apiToken: string, fingerprint: string }>}
 */
function usableAccounts() {
  return ring.usable().map(entry => ({ ...entry.credential, fingerprint: entry.fingerprint }));
}

/**
 * Record that an account served a call, so the next one starts on it directly.
 * @param {string} fingerprint
 * @returns {Promise<void>}
 */
function markWorking(fingerprint) {
  return ring.markWorking(fingerprint);
}

/**
 * Record that Cloudflare has stopped serving this account for the day.
 * @param {string} fingerprint
 * @returns {Promise<void>}
 */
async function markExhausted(fingerprint) {
  await ring.markExhausted(fingerprint);
}

export {
  CLOUDFLARE_STATE_FILE,
  isCloudflareConfigured,
  usableAccounts,
  markWorking,
  markExhausted
};
