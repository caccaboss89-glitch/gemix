// src/ai/credentials/nativeOAuthCredentialProvider.js
//
// The OAuth-backed CredentialProvider: GemiX's own store, its own refresh, its
// own multi-account pool.
//
// Token expiry is known, so refresh happens before the request and the first
// call of a turn already carries a valid token. The reactive path is reserved
// for a provider rejecting a token that still appeared valid locally.
//
// Pool behaviour: accounts are ordered by health then priority. A refresh that
// fails marks the account `auth_failed` and the next `get()` moves on to the
// next account, so one dead login does not take the deployment down.
//
// Refresh tokens are single-use: the rotated pair is persisted before the new
// access token is handed to anyone.

import { CredentialProvider } from './credentialProvider.js';
import {
  orderPool,
  patchAccount,
  readPool,
  storePath,
  updateAccountExclusive,
  updatePool
} from './credentialStore.js';
import { isDescriptorConfigured, oauthDescriptorFor } from './oauthProviders.js';
import { refreshAccessToken } from './oauthClient.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Credentials');

/**
 * Refresh this far ahead of expiry. xAI access tokens last about six hours, so
 * one hour of headroom means a long turn can never straddle the boundary.
 */
const PROACTIVE_REFRESH_MS = 60 * 60 * 1000;

class NativeOAuthCredentialProvider extends CredentialProvider {
  /**
   * @param {object} opts
   * @param {string} opts.pool - credential-store pool name
   * @param {string} [opts.defaultBaseUrl] - used when an account stores none
   * @param {(account: object) => object} [opts.extraHeaders] - provider headers
   * @param {Function} [opts.fetchImpl] - injected for tests
   */
  constructor(opts) {
    super({ id: `${opts.pool}-oauth` });
    this.pool = opts.pool;
    this.defaultBaseUrl = opts.defaultBaseUrl ? String(opts.defaultBaseUrl).replace(/\/+$/, '') : '';
    this._extraHeaders = opts.extraHeaders || (() => ({}));
    this._fetchImpl = opts.fetchImpl;
    /** Single-flight refresh per account id. */
    this._refreshes = new Map();
    this._currentAccountId = null;
  }

  get _descriptor() {
    return oauthDescriptorFor(this.pool);
  }

  /** The account this provider should be using right now. */
  _pickAccount() {
    const accounts = orderPool(readPool(this.pool));
    if (accounts.length === 0) {
      throw new Error(
        `no ${this.pool} account is stored. Run "npm run auth -- login ${this.pool}" `
        + `(store: ${storePath(this.pool)}).`
      );
    }
    return accounts[0];
  }

  _toCredential(account) {
    return {
      accessToken: account.accessToken,
      baseUrl: account.baseUrl || this.defaultBaseUrl,
      headers: this._extraHeaders(account) || {},
      expiresAtMs: account.expiresAtMs,
      accountId: account.id
    };
  }

  /** True when the stored token will not survive `minRemainingMs` of work. */
  _needsRefresh(account, minRemainingMs) {
    if (!account.accessToken) return true;
    if (account.expiresAtMs === null) return false;
    const headroom = Math.max(PROACTIVE_REFRESH_MS, minRemainingMs || 0);
    return account.expiresAtMs - Date.now() <= headroom;
  }

  _hasRequiredLifetime(account, minRemainingMs = 0) {
    if (!account.accessToken) return false;
    if (account.expiresAtMs === null) return true;
    return account.expiresAtMs - Date.now() > Math.max(0, minRemainingMs);
  }

  async _markAuthFailedIfCurrent(account) {
    await updatePool(this.pool, accounts => accounts.map((current) => {
      if (current.id !== account.id) return current;
      if (current.accessToken !== account.accessToken || current.refreshToken !== account.refreshToken) {
        return current;
      }
      return { ...current, lastStatus: 'auth_failed', lastStatusAt: Date.now() };
    }));
  }

  /**
   * Refresh one account, persisting the rotated pair before returning it.
   * Concurrent callers share the single in-flight exchange.
   */
  async _refreshAccount(account, opts = {}) {
    const inFlight = this._refreshes.get(account.id);
    if (inFlight) return inFlight;

    const descriptor = this._descriptor;
    const configured = isDescriptorConfigured(descriptor);
    if (!configured.ok) throw new Error(configured.reason);

    let exchanged = false;
    const run = updateAccountExclusive(this.pool, account.id, async (current) => {
      const changedByAnotherProcess = current.accessToken !== account.accessToken
        || current.refreshToken !== account.refreshToken;
      if (changedByAnotherProcess && this._hasRequiredLifetime(current, opts.minRemainingMs)) {
        return current;
      }
      if (!opts.force && !this._needsRefresh(current, opts.minRemainingMs)) return current;
      if (!current.refreshToken) throw new Error(`account "${current.id}" has no refresh token`);
      let tokens;
      try {
        tokens = await refreshAccessToken(descriptor, current.refreshToken, { fetchImpl: this._fetchImpl });
      } catch (err) {
        err.credentialSnapshot = current;
        throw err;
      }
      exchanged = true;
      return {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        lastStatus: 'ok',
        lastStatusAt: Date.now()
      };
    }).then((current) => {
      if (exchanged) log.info(`${this.pool}: refreshed account "${account.id}"`);
      return current;
    }).finally(() => {
      this._refreshes.delete(account.id);
    });

    this._refreshes.set(account.id, run);
    return run;
  }

  /**
   * Find the next account that can actually authorize a request. An access
   * token being present is not enough: expired candidates are refreshed before
   * they are returned, and unusable candidates are marked and skipped.
   */
  async _rotateToUsableAccount(failedAccountId, originalError, opts = {}) {
    const candidates = orderPool(readPool(this.pool)).filter(a => a.id !== failedAccountId);
    let lastError = originalError;

    for (let account of candidates) {
      this._currentAccountId = account.id;
      if (!this._needsRefresh(account, opts.minRemainingMs)) {
        log.warn(`${this.pool}: rotating to account "${account.id}"`);
        return this._toCredential(account);
      }

      try {
        account = await this._refreshAccount(account, { minRemainingMs: opts.minRemainingMs });
        this._currentAccountId = account.id;
        log.warn(`${this.pool}: rotating to refreshed account "${account.id}"`);
        return this._toCredential(account);
      } catch (err) {
        lastError = err;
        const latest = readPool(this.pool).find(candidate => candidate.id === account.id) || account;
        const stillValid = this._hasRequiredLifetime(latest, opts.minRemainingMs);
        log.warn(`${this.pool}: candidate account "${account.id}" could not refresh (${err.message})`);
        if (stillValid) return this._toCredential(latest);
        await this._markAuthFailedIfCurrent(err.credentialSnapshot || account);
      }
    }

    throw lastError;
  }

  /**
   * A credential valid for at least `minRemainingMs`, refreshing first when the
   * stored one is too close to expiry.
   *
   * @param {object} [opts]
   * @param {number} [opts.minRemainingMs]
   * @returns {Promise<import('./credentialProvider.js').Credential>}
   */
  async get(opts = {}) {
    let account = this._pickAccount();
    this._currentAccountId = account.id;

    if (this._needsRefresh(account, opts.minRemainingMs)) {
      try {
        account = await this._refreshAccount(account, { minRemainingMs: opts.minRemainingMs });
      } catch (err) {
        // An account with a live token and a broken refresh is still worth one
        // try; one with neither has to step aside for the next in the pool.
        const latest = readPool(this.pool).find(candidate => candidate.id === account.id) || account;
        const stillValid = this._hasRequiredLifetime(latest, opts.minRemainingMs);
        log.warn(`${this.pool}: proactive refresh of "${account.id}" failed (${err.message})`);
        if (!stillValid) {
          await this._markAuthFailedIfCurrent(err.credentialSnapshot || account);
          return this._rotateToUsableAccount(account.id, err, opts);
        }
        account = latest;
      }
    }

    return this._toCredential(account);
  }

  /**
   * Force a refresh after the provider rejected the current credential.
   * The transport calls this at most once per request.
   */
  async refresh(opts = {}) {
    const accounts = readPool(this.pool);
    const requestedId = opts.accountId || this._currentAccountId;
    const account = (requestedId && accounts.find(a => a.id === requestedId)) || this._pickAccount();
    try {
      const refreshed = await this._refreshAccount(account, { force: true, minRemainingMs: opts.minRemainingMs });
      this._currentAccountId = refreshed.id;
      return this._toCredential(refreshed);
    } catch (err) {
      await this._markAuthFailedIfCurrent(err.credentialSnapshot || account);
      return this._rotateToUsableAccount(account.id, err, opts);
    }
  }

  /**
   * Record how the last request went so a failing account drops down the pool.
   * Repeating the same status is not re-persisted: an `ok` on every call would
   * rewrite the store several times a turn for no new information.
   */
  async markStatus(status, accountId = null) {
    const id = accountId || this._currentAccountId;
    if (!id) return;
    const current = readPool(this.pool).find(a => a.id === id);
    if (!current || current.lastStatus === status) return;
    try {
      await patchAccount(this.pool, id, { lastStatus: status, lastStatusAt: Date.now() });
    } catch (err) {
      log.warn(`${this.pool}: cannot record status for "${id}": ${err.message}`);
    }
  }

  describe() {
    const accounts = readPool(this.pool);
    if (accounts.length === 0) return `${this.pool} OAuth (no account stored)`;
    const healthy = accounts.filter(a => a.lastStatus === 'ok').length;
    return `${this.pool} OAuth (${accounts.length} account(s), ${healthy} healthy)`;
  }
}

export { NativeOAuthCredentialProvider, PROACTIVE_REFRESH_MS };
