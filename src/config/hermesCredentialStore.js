// src/config/hermesCredentialStore.js
//
// Shared reader for Hermes `auth.json` credential pools.
//
// The pool is always named by the caller. `active_provider` inside the file is
// deliberately ignored: it records which provider the Hermes CLI last used, and
// letting it pick would mean GemiX could send an xAI token to the Codex backend
// (or the reverse) after any unrelated Hermes invocation.
//
// Shape:
//   {
//     "active_provider": "…",            // ignored here
//     "credential_pool": {
//       "xai-oauth":    [ { "access_token": "…", "base_url": "…", … } ],
//       "openai-codex": [ { "access_token": "…", "account_id": "…", "expires_at": …, … } ]
//     }
//   }
//
// Entries are returned atomically: a caller never sees a token from one entry
// paired with an account id from another. Nothing in this module logs, throws
// or returns a credential value inside a message.

import fs from 'fs';

/** Treat a token as already expired this many ms before its stated expiry. */
const EXPIRY_SKEW_MS = 60_000;

/** Cache keyed by auth file path: { mtimeMs, size, parsed }. */
const _fileCache = new Map();

/**
 * Parse the auth file, reusing the cached parse while the file is unchanged.
 * @param {string} authFile
 * @param {boolean} forceReload - bypass the cache (after a 401 or a refresh)
 * @returns {object}
 */
function _readAuthFile(authFile, forceReload) {
  let stat;
  try {
    stat = fs.statSync(authFile);
  } catch (err) {
    throw new Error(`Hermes auth file not found at ${authFile}: ${err.message}`);
  }

  const cached = _fileCache.get(authFile);
  if (!forceReload && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot parse Hermes auth file ${authFile}: ${err.message}`);
  }
  _fileCache.set(authFile, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

/** Milliseconds-since-epoch expiry from the several shapes Hermes writes. */
function _expiryMs(entry) {
  const raw = entry.expires_at ?? entry.expiresAt ?? entry.exp;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Seconds vs milliseconds: anything below year 2286 in ms is a seconds value.
    return raw < 1e11 ? raw * 1000 : raw;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Usable entries of a pool, best first.
 * Ordering matches the xAI reader GemiX has always used: entries whose last
 * call succeeded come first, then by explicit priority, then file order.
 */
function _rankPool(pool, { requireAccountId, now }) {
  return pool
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (!entry || typeof entry.access_token !== 'string' || !entry.access_token) return false;
      if (requireAccountId && !_accountIdOf(entry)) return false;
      const expiry = _expiryMs(entry);
      return expiry === null || expiry - EXPIRY_SKEW_MS > now;
    })
    .sort((a, b) => {
      const okA = !a.entry.last_status || a.entry.last_status === 'ok' ? 0 : 1;
      const okB = !b.entry.last_status || b.entry.last_status === 'ok' ? 0 : 1;
      if (okA !== okB) return okA - okB;
      const prioA = a.entry.priority ?? 0;
      const prioB = b.entry.priority ?? 0;
      if (prioA !== prioB) return prioA - prioB;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function _accountIdOf(entry) {
  const raw = entry.account_id ?? entry.chatgpt_account_id ?? entry.accountId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Read one credential from an explicitly named Hermes pool.
 *
 * @param {object} opts
 * @param {string} opts.authFile - path to auth.json
 * @param {string} opts.pool - pool name, e.g. 'xai-oauth' or 'openai-codex'
 * @param {boolean} [opts.requireAccountId] - reject entries without an account id
 * @param {boolean} [opts.forceReload] - re-read from disk instead of the cache
 * @param {number} [opts.now] - clock override for tests
 * @returns {{ accessToken: string, accountId: string|null, baseUrl: string|null, expiresAtMs: number|null }}
 */
function readPoolCredential({ authFile, pool, requireAccountId = false, forceReload = false, now = Date.now() }) {
  if (typeof pool !== 'string' || !pool) {
    throw new Error('readPoolCredential requires an explicit pool name.');
  }
  const parsed = _readAuthFile(authFile, forceReload);
  const entries = parsed?.credential_pool?.[pool];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`No credentials for Hermes pool "${pool}" in ${authFile}`);
  }

  const usable = _rankPool(entries, { requireAccountId, now });
  if (usable.length === 0) {
    const detail = requireAccountId
      ? 'every entry is expired or missing an access token / account id'
      : 'every entry is expired or missing an access token';
    throw new Error(`No usable credential in Hermes pool "${pool}" (${detail}).`);
  }

  const entry = usable[0];
  const baseUrl = typeof entry.base_url === 'string' && entry.base_url.trim()
    ? entry.base_url.trim().replace(/\/+$/, '')
    : null;

  return {
    accessToken: entry.access_token,
    accountId: _accountIdOf(entry),
    baseUrl,
    expiresAtMs: _expiryMs(entry)
  };
}

/** Drop the cached parse of one file (or of every file when omitted). */
function invalidateAuthFileCache(authFile) {
  if (authFile) _fileCache.delete(authFile);
  else _fileCache.clear();
}

export { readPoolCredential, invalidateAuthFileCache, EXPIRY_SKEW_MS };
