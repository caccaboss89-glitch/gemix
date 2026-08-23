// src/ai/credentials/nativeOAuthCredentialProvider.js
//
// The OAuth-backed CredentialProvider: GemiX's own store, its own refresh, its
// own multi-account pool.
//
// The shape of the old mechanism was: a call fails, GemiX shells out to an
// external CLI, the CLI spends a real subscription request so the file it owns
// gets rewritten, GemiX re-reads it and retries. That cost up to two minutes and
// a slice of the plan for what is one HTTPS round trip. Here the expiry is
// known, so the refresh happens BEFORE the call — the first request of a turn
// already carries a valid token — and the reactive path exists only for the
// case where the provider rejects a token we believed was good.
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
  storePath
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

  /**
   * Refresh one account, persisting the rotated pair before returning it.
   * Concurrent callers share the single in-flight exchange.
   */
  async _refreshAccount(account) {
    const inFlight = this._refreshes.get(account.id);
    if (inFlight) return inFlight;

    const descriptor = this._descriptor;
    const configured = isDescriptorConfigured(descriptor);
    if (!configured.ok) throw new Error(configured.reason);

    const run = (async () => {
      const tokens = await refreshAccessToken(descriptor, account.refreshToken, { fetchImpl: this._fetchImpl });
      // Persist first: the refresh token that produced these is already dead.
      await patchAccount(this.pool, account.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        lastStatus: 'ok',
        lastStatusAt: Date.now()
      });
      log.info(`${this.pool}: refreshed account "${account.id}"`);
      return { ...account, ...tokens, lastStatus: 'ok' };
    })().finally(() => {
      this._refreshes.delete(account.id);
    });

    this._refreshes.set(account.id, run);
    return run;
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
        account = await this._refreshAccount(account);
      } catch (err) {
        // An account with a live token and a broken refresh is still worth one
        // try; one with neither has to step aside for the next in the pool.
        const stillValid = account.accessToken
          && (account.expiresAtMs === null || account.expiresAtMs > Date.now());
        log.warn(`${this.pool}: proactive refresh of "${account.id}" failed (${err.message})`);
        if (!stillValid) {
          await patchAccount(this.pool, account.id, { lastStatus: 'auth_failed', lastStatusAt: Date.now() });
          const next = orderPool(readPool(this.pool)).find(a => a.id !== account.id && a.accessToken);
          if (!next) throw err;
          log.warn(`${this.pool}: rotating to account "${next.id}"`);
          this._currentAccountId = next.id;
          return this._toCredential(next);
        }
      }
    }

    return this._toCredential(account);
  }

  /**
   * Force a refresh after the provider rejected the current credential.
   * The transport calls this at most once per request.
   */
  async refresh() {
    const account = this._pickAccount();
    try {
      const refreshed = await this._refreshAccount(account);
      this._currentAccountId = refreshed.id;
      return this._toCredential(refreshed);
    } catch (err) {
      await patchAccount(this.pool, account.id, { lastStatus: 'auth_failed', lastStatusAt: Date.now() });
      const next = orderPool(readPool(this.pool)).find(a => a.id !== account.id && a.accessToken);
      if (!next) throw err;
      log.warn(`${this.pool}: account "${account.id}" could not be refreshed; rotating to "${next.id}"`);
      this._currentAccountId = next.id;
      return this._toCredential(next);
    }
  }

  /**
   * Record how the last request went so a failing account drops down the pool.
   * Repeating the same status is not re-persisted: an `ok` on every call would
   * rewrite the store several times a turn for no new information.
   */
  markStatus(status, accountId = null) {
    const id = accountId || this._currentAccountId;
    if (!id) return;
    const current = readPool(this.pool).find(a => a.id === id);
    if (!current || current.lastStatus === status) return;
    patchAccount(this.pool, id, { lastStatus: status, lastStatusAt: Date.now() })
      .catch(err => log.warn(`${this.pool}: cannot record status for "${id}": ${err.message}`));
  }

  describe() {
    const accounts = readPool(this.pool);
    if (accounts.length === 0) return `${this.pool} OAuth (no account stored)`;
    const healthy = accounts.filter(a => a.lastStatus === 'ok').length;
    return `${this.pool} OAuth (${accounts.length} account(s), ${healthy} healthy)`;
  }
}

export { NativeOAuthCredentialProvider, PROACTIVE_REFRESH_MS };
