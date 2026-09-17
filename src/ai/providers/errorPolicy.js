// src/ai/providers/errorPolicy.js
//
// What the user is told when the backend refused the turn.
//
// The decision is made on the typed kind the transport attached to the error,
// never on an error message's wording. Exhausted allowances use one
// provider-neutral GemiX notice; temporary throttling remains a separate case.
//
// A kind with nothing specific to say returns null, and the caller sends its
// generic fallback and logs the error as usual.

import { TRANSPORT_ERROR, isTransportError } from '../transport/errors.js';
import {
  CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_LIMIT_MESSAGE,
  PROVIDER_AUTH_MESSAGE
} from '../../config/systemMessages.js';

/** Kinds worth a specific reply; anything else falls through to the generic one. */
const NEUTRAL_MESSAGES = Object.freeze({
  [TRANSPORT_ERROR.QUOTA]: CREDIT_EXHAUSTED_MESSAGE,
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

  const text = NEUTRAL_MESSAGES[err.kind];
  if (!text) return null;
  return {
    text,
    logLine: err.kind === TRANSPORT_ERROR.QUOTA
      ? `${profile?.displayName || 'The model'} credits exhausted — replying with the credit notice.`
      : `${profile?.displayName || 'The model'} refused the turn (${err.kind}).`,
    // An expired allowance is expected and self-healing; a credential the
    // deployment has to fix is not.
    notifyAdmin: err.kind === TRANSPORT_ERROR.AUTH
  };
}

export { providerFailureReply };
