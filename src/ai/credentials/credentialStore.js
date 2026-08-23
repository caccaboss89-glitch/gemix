// src/ai/credentials/credentialStore.js
//
// GemiX's own credential store: one file per provider, holding an explicit
// pool of accounts.
//
// Three properties matter and are the reason this is not a plain JSON read:
//
//   1. Refresh tokens are single-use. The moment a rotated pair comes back it
//      has to be on disk, or a crash between the exchange and the write leaves
//      the account permanently unusable. Every mutation is a temp-file write
//      plus a rename, and the rename is what makes it atomic.
//   2. Two turns can refresh at once. All read-modify-write goes through one
//      in-process chain, so a concurrent update cannot clobber a rotation.
//   3. The file holds bearer and refresh tokens, so it is created 0600 and
//      never leaves the host process — nothing here is ever handed to the
//      container the model controls.
//
// There is no `active_provider`: a CredentialProvider names the pool it wants.

import fs from 'fs';
import path from 'path';
import constants from '../../config/constants.js';
import { createLogger } from '../../utils/logger.js';
import { withKeyedLock } from '../../utils/keyedLock.js';

const log = createLogger('Credentials');

const STORE_DIR = path.join(constants.DATA_DIR, 'credentials');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Per-provider chain so a concurrent rotation cannot clobber another. */
const _locks = new Map();

/**
 * @typedef {object} StoredAccount
 * @property {string} id - stable local identifier, unique inside the pool
 * @property {string} [label] - human-readable hint (never a secret)
 * @property {string} accessToken
 * @property {string|null} refreshToken - single-use; rotated on every refresh
 * @property {number|null} expiresAtMs
 * @property {string|null} [accountId] - provider-side account id, when it sends one
 * @property {string|null} [baseUrl] - overrides the profile base URL for this account
 * @property {number} priority - lower is tried first
 * @property {'ok'|'auth_failed'|'quota'|'error'} lastStatus
 * @property {number|null} lastStatusAt
 */

function _sanitizeProvider(provider) {
  const clean = String(provider || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean) throw new Error('credentialStore: a provider name is required');
  return clean;
}

function _storeFile(provider) {
  return path.join(STORE_DIR, `${_sanitizeProvider(provider)}.json`);
}

function _ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: DIR_MODE });
  }
  // Best-effort on POSIX; a no-op that throws nothing on Windows dev boxes.
  try { fs.chmodSync(STORE_DIR, DIR_MODE); } catch { /* not supported here */ }
}

function _normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken : '';
  if (!accessToken && typeof raw.refreshToken !== 'string') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `account-${index + 1}`,
    label: typeof raw.label === 'string' ? raw.label : '',
    accessToken,
    refreshToken: typeof raw.refreshToken === 'string' && raw.refreshToken ? raw.refreshToken : null,
    expiresAtMs: Number.isFinite(raw.expiresAtMs) ? raw.expiresAtMs : null,
    accountId: typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : null,
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl.replace(/\/+$/, '') : null,
    priority: Number.isFinite(raw.priority) ? raw.priority : index,
    lastStatus: ['ok', 'auth_failed', 'quota', 'error'].includes(raw.lastStatus) ? raw.lastStatus : 'ok',
    lastStatusAt: Number.isFinite(raw.lastStatusAt) ? raw.lastStatusAt : null
  };
}

/**
 * Read one provider's pool. A missing or unreadable file is an empty pool, not
 * an error: the deployment may simply not have logged in yet.
 *
 * @param {string} provider
 * @returns {StoredAccount[]}
 */
function readPool(provider) {
  const file = _storeFile(provider);
  let raw;
  try {
    if (!fs.existsSync(file)) return [];
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    log.warn(`Cannot read the ${provider} credential store (${err.message}); treating it as empty`);
    return [];
  }
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  return accounts.map(_normalizeAccount).filter(Boolean);
}

/** Write the whole pool atomically with 0600 permissions. */
function _writePool(provider, accounts) {
  _ensureDir();
  const file = _storeFile(provider);
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify({ provider: _sanitizeProvider(provider), accounts }, null, 2);
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf-8', mode: FILE_MODE });
    try { fs.chmodSync(tmp, FILE_MODE); } catch { /* not supported here */ }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    throw new Error(`Cannot persist the ${provider} credential store: ${err.message}`);
  }
}

/**
 * Read-modify-write one provider's pool under the provider's own lock.
 *
 * @param {string} provider
 * @param {(accounts: StoredAccount[]) => StoredAccount[]} mutate
 * @returns {Promise<StoredAccount[]>} the pool as it was written
 */
function updatePool(provider, mutate) {
  return withKeyedLock(_locks, _sanitizeProvider(provider), async () => {
    const next = mutate(readPool(provider)) || [];
    _writePool(provider, next);
    return next;
  });
}

/**
 * Insert or replace one account, keyed by id.
 *
 * @param {string} provider
 * @param {StoredAccount} account
 * @returns {Promise<StoredAccount[]>}
 */
function upsertAccount(provider, account) {
  const normalized = _normalizeAccount(account, 0);
  if (!normalized) throw new Error('credentialStore: the account carries no token');
  if (account?.id) normalized.id = account.id;
  return updatePool(provider, (accounts) => {
    const idx = accounts.findIndex(a => a.id === normalized.id);
    if (idx === -1) return [...accounts, { ...normalized, priority: accounts.length }];
    const merged = [...accounts];
    merged[idx] = { ...merged[idx], ...normalized };
    return merged;
  });
}

/**
 * Patch one account in place. Used for the rotated token pair and for the
 * `lastStatus` marking that drives pool rotation.
 *
 * @param {string} provider
 * @param {string} accountId
 * @param {Partial<StoredAccount>} patch
 * @returns {Promise<StoredAccount[]>}
 */
function patchAccount(provider, accountId, patch) {
  return updatePool(provider, (accounts) => accounts.map(
    a => (a.id === accountId ? { ...a, ...patch } : a)
  ));
}

/**
 * Remove one account from the pool.
 * @param {string} provider
 * @param {string} accountId
 * @returns {Promise<StoredAccount[]>}
 */
function removeAccount(provider, accountId) {
  return updatePool(provider, (accounts) => accounts.filter(a => a.id !== accountId));
}

/**
 * Pool order: accounts whose last request succeeded first, then by priority.
 * An account with no refresh token and an expired access token is unusable and
 * sorts last rather than being dropped — the operator may still want to see it.
 *
 * @param {StoredAccount[]} accounts
 * @param {number} [now]
 * @returns {StoredAccount[]}
 */
function orderPool(accounts, now = Date.now()) {
  const usable = (a) => {
    if (a.refreshToken) return 0;
    if (a.expiresAtMs === null) return 0;
    return a.expiresAtMs > now ? 0 : 1;
  };
  const healthy = (a) => (a.lastStatus === 'ok' ? 0 : 1);
  return [...accounts].sort((a, b) => usable(a) - usable(b)
    || healthy(a) - healthy(b)
    || a.priority - b.priority);
}

/** Absolute path of one provider's store file, for operator-facing messages. */
function storePath(provider) {
  return _storeFile(provider);
}

/** Provider names that currently have a store file. */
function listProviders() {
  try {
    if (!fs.existsSync(STORE_DIR)) return [];
    return fs.readdirSync(STORE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export {
  STORE_DIR,
  readPool,
  updatePool,
  upsertAccount,
  patchAccount,
  removeAccount,
  orderPool,
  storePath,
  listProviders
};
