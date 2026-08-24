// src/ai/credentials/credentialProvider.js
//
// The contract every credential source implements, and the one implementation
// that needs no state: a static API key.
//
// A CredentialProvider answers a single question — "what should this request be
// authenticated with right now" — and owns everything behind it: refresh,
// expiry, rotation, multi-account pools. The transport never reads a token
// from disk, never knows what an OAuth flow is, and never sees a refresh token.
//
// Nothing a provider returns may be handed to the container the model controls
// (see sandbox/): a credential lives in the host process and in the outbound
// HTTP header, nowhere else.
//
// The OAuth-backed providers (native xAI, native Codex) live alongside this
// file and implement the same three methods.

/**
 * @typedef {object} Credential
 * @property {string} accessToken - bearer value for the Authorization header
 * @property {string} baseUrl - API root this credential is valid against
 * @property {object} [headers] - extra provider headers (e.g. an account id)
 * @property {number|null} [expiresAtMs] - epoch ms, or null when unknown
 * @property {string|null} [accountId] - which pool entry answered, for logs
 */

class CredentialProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.id] - short label used in logs and preflight output
   */
  constructor(opts = {}) {
    this.id = opts.id || 'credential-provider';
  }

  /**
   * A credential valid for at least `minRemainingMs`, refreshing first when the
   * current one is too close to expiry.
   *
   * @param {object} [opts]
   * @param {number} [opts.minRemainingMs]
   * @returns {Promise<Credential>}
   */
  // eslint-disable-next-line no-unused-vars
  async get(opts = {}) {
    throw new Error(`${this.id}: get() is not implemented`);
  }

  /**
   * Force a refresh after the provider rejected the current credential.
   * Called at most once per request by the transport.
   *
   * @param {object} [opts]
   * @returns {Promise<Credential>}
   */
  // eslint-disable-next-line no-unused-vars
  async refresh(opts = {}) {
    throw new Error(`${this.id}: refresh() is not implemented`);
  }

  /**
   * Record how the last request using this credential ended, so a pool can
   * demote or rotate an account that keeps failing.
   *
   * @param {'ok'|'auth_failed'|'quota'|'error'} status
   * @param {string|null} [accountId]
   */
  // eslint-disable-next-line no-unused-vars
  async markStatus(status, accountId = null) { /* stateless providers have nothing to record */ }

  /** Human-readable source description for startup logs (never a secret). */
  describe() {
    return this.id;
  }
}

/**
 * A credential that never changes: the key comes from configuration and there
 * is nothing to refresh. Used for API-key profiles (xAI API key, OpenRouter,
 * custom Responses endpoints).
 */
class ApiKeyCredentialProvider extends CredentialProvider {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.baseUrl
   * @param {string} [opts.id]
   * @param {object} [opts.headers]
   */
  constructor(opts) {
    super({ id: opts.id || 'api-key' });
    this._apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    this._baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
    this._headers = opts.headers || {};
  }

  async get() {
    if (!this._apiKey) {
      throw new Error(`${this.id}: no API key configured`);
    }
    return {
      accessToken: this._apiKey,
      baseUrl: this._baseUrl,
      headers: { ...this._headers },
      expiresAtMs: null,
      accountId: null
    };
  }

  /** A static key cannot be refreshed: a rejection means the key itself is wrong. */
  async refresh() {
    throw new Error(`${this.id}: the configured API key was rejected and cannot be refreshed`);
  }

  describe() {
    return `${this.id} (${this._baseUrl})`;
  }
}

export { CredentialProvider, ApiKeyCredentialProvider };
