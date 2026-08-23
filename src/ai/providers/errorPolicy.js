// src/ai/providers/errorPolicy.js
//
// What the user is told when the backend refused the turn.
//
// The decision is made on two facts only: the typed kind the transport
// attached to the error, and which profile is active. Never on the wording of
// a message — the SuperGrok credit notice names a plan, a provider and a weekly
// renewal, so it may only ever answer a QUOTA failure that really came from the
// xAI profile. Every other profile gets copy that names no provider at all: the
// user cannot act on which backend GemiX runs.
//
// A kind with nothing specific to say returns null, and the caller sends its
// generic fallback and logs the error as usual.

import { TRANSPORT_ERROR, isTransportError } from '../transport/errors.js';
import {
  GROK_CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_LIMIT_MESSAGE,
  PROVIDER_AUTH_MESSAGE
} from '../../config/systemMessages.js';
import { PROVIDER } from './providerProfile.js';

/** Kinds worth a specific reply; anything else falls through to the generic one. */
const NEUTRAL_MESSAGES = Object.freeze({
  [TRANSPORT_ERROR.QUOTA]: PROVIDER_LIMIT_MESSAGE,
  [TRANSPORT_ERROR.RATE_LIMIT]: PROVIDER_LIMIT_MESSAGE,
  [TRANSPORT_ERROR.AUTH]: PROVIDER_AUTH_MESSAGE
});

/**
 * The reply for a turn that died at the provider.
 *
 * @param {unknown} err
 * @param {object} profile - the turn's ProviderProfile
 * @returns {{ text: string, logLine: string, notifyAdmin: boolean }|null}
 */
function providerFailureReply(err, profile) {
  if (!isTransportError(err)) return null;

  if (profile?.id === PROVIDER.XAI && err.kind === TRANSPORT_ERROR.QUOTA) {
    return {
      text: GROK_CREDIT_EXHAUSTED_MESSAGE,
      logLine: 'Grok credits exhausted — replying with the credit notice (admin not notified).',
      notifyAdmin: false
    };
  }

  const text = NEUTRAL_MESSAGES[err.kind];
  if (!text) return null;
  return {
    text,
    logLine: `${profile?.displayName || 'The model'} refused the turn (${err.kind}).`,
    // An expired allowance is expected and self-healing; a credential the
    // deployment has to fix is not.
    notifyAdmin: err.kind === TRANSPORT_ERROR.AUTH
  };
}

export { providerFailureReply };
