// src/ai/credentials/credentialImport.js
//
// A one-time shortcut into GemiX's own store: read the tokens an external CLI
// already obtained, and adopt them.
//
// This exists so a deployment that was running on `~/.hermes/auth.json` or
// `~/.codex/auth.json` does not have to re-authorize from scratch. It is
// bootstrap only — after the import the credential belongs to GemiX, and the
// external CLI must not keep using it: refresh tokens are single-use, so
// whichever side refreshes first invalidates the other's copy.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { upsertAccount } from './credentialStore.js';
import { CREDENTIAL_POOL } from './oauthProviders.js';

/** Default locations of the two files worth importing from. */
const IMPORT_SOURCES = Object.freeze({
  [CREDENTIAL_POOL.XAI]: path.join(os.homedir(), '.hermes', 'auth.json'),
  [CREDENTIAL_POOL.CHATGPT]: path.join(os.homedir(), '.codex', 'auth.json')
});

function _expiryFrom(entry) {
  for (const key of ['expires_at_ms', 'expiresAtMs']) {
    if (Number.isFinite(entry?.[key])) return entry[key];
  }
  for (const key of ['expires_at', 'expiresAt']) {
    const value = entry?.[key];
    if (Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (Number.isFinite(entry?.expires_in)) return Date.now() + entry.expires_in * 1000;
  return null;
}

function _accountFrom(entry, index, fallbackId) {
  const accessToken = entry?.access_token || entry?.accessToken || null;
  const refreshToken = entry?.refresh_token || entry?.refreshToken || null;
  if (!accessToken && !refreshToken) return null;
  return {
    id: entry?.id || entry?.account_id || entry?.email || `${fallbackId}-${index + 1}`,
    label: entry?.label || entry?.email || '',
    accessToken: accessToken || '',
    refreshToken,
    expiresAtMs: _expiryFrom(entry),
    accountId: entry?.account_id || entry?.chatgpt_account_id || entry?.accountId || null,
    baseUrl: entry?.base_url || entry?.baseUrl || null,
    priority: index,
    lastStatus: 'ok',
    lastStatusAt: null
  };
}

/**
 * Every credential entry an external auth file holds, whatever shape it uses.
 *
 * Handles the three seen in the wild: a bare `{access_token, refresh_token}`
 * object, a `tokens` sub-object (Codex), and a `credential_pool` map keyed by
 * provider (Hermes). The pool map is read by NAME, never through the file's own
 * `active_provider` field — that implicit selection is exactly what the native
 * store replaces.
 *
 * @param {object} parsed - the parsed auth file
 * @param {string} pool - GemiX pool being imported into
 * @param {string|null} [poolKey] - which key to read out of a credential_pool map
 * @returns {object[]}
 */
function extractAccounts(parsed, pool, poolKey = null) {
  if (!parsed || typeof parsed !== 'object') return [];

  if (parsed.credential_pool && typeof parsed.credential_pool === 'object') {
    const keys = poolKey
      ? [poolKey]
      : Object.keys(parsed.credential_pool).filter(k => k.toLowerCase().includes(pool));
    const out = [];
    for (const key of keys) {
      const entries = parsed.credential_pool[key];
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, i) => {
        const account = _accountFrom(entry, out.length + i, key);
        if (account) out.push(account);
      });
    }
    return out;
  }

  const single = _accountFrom(parsed.tokens || parsed, 0, pool);
  if (!single) return [];
  // Codex keeps the routing account id next to the tokens rather than inside them.
  if (!single.accountId && typeof parsed.account_id === 'string') single.accountId = parsed.account_id;
  return [single];
}

/**
 * Import an external auth file into a GemiX pool.
 *
 * @param {object} opts
 * @param {string} opts.pool
 * @param {string} [opts.file] - defaults to the pool's usual location
 * @param {string} [opts.poolKey] - key inside a credential_pool map
 * @returns {Promise<{ imported: number, file: string, ids: string[] }>}
 */
async function importExternalCredentials({ pool, file, poolKey = null }) {
  const sourceFile = file || IMPORT_SOURCES[pool];
  if (!sourceFile) throw new Error(`No default import location for pool "${pool}"; pass a file path.`);
  if (!fs.existsSync(sourceFile)) throw new Error(`No auth file at ${sourceFile}`);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot parse ${sourceFile}: ${err.message}`);
  }

  const accounts = extractAccounts(parsed, pool, poolKey);
  if (accounts.length === 0) {
    throw new Error(`No usable credential found in ${sourceFile}`);
  }
  for (const account of accounts) {
    await upsertAccount(pool, account);
  }
  return { imported: accounts.length, file: sourceFile, ids: accounts.map(a => a.id) };
}

export { IMPORT_SOURCES, extractAccounts, importExternalCredentials };
