// src/ai/credentials/xaiAuthFileCredentialProvider.js
//
// PHASE 1 BRIDGE. The xAI OAuth credential as it exists today: a token read
// from the external auth file, with no refresh of its own.
//
// It exists only so the transport has a working CredentialProvider before the
// native auth subsystem lands. Phase 2 replaces it with
// nativeXaiOAuthCredentialProvider.js — GemiX's own store, PKCE login and
// proactive refresh — and this file goes away with it.

import { CredentialProvider } from './credentialProvider.js';
import { getXaiAuth, describeXaiAuthSource } from '../../config/xaiAuth.js';

class XaiAuthFileCredentialProvider extends CredentialProvider {
  constructor() {
    super({ id: 'xai-oauth-file' });
  }

  async get() {
    const { token, baseUrl } = getXaiAuth();
    return { accessToken: token, baseUrl, headers: {}, expiresAtMs: null, accountId: null };
  }

  /** No refresh of its own: re-read the file in case something else rotated it. */
  async refresh() {
    const { token, baseUrl } = getXaiAuth(true);
    return { accessToken: token, baseUrl, headers: {}, expiresAtMs: null, accountId: null };
  }

  describe() {
    return describeXaiAuthSource();
  }
}

export { XaiAuthFileCredentialProvider };
