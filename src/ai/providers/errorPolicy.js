// src/ai/providers/errorPolicy.js
//
// What the user is told when the back end refused the turn.
//
// The SuperGrok credit notice names a plan, a provider and a weekly renewal, so
// it may only ever answer an error that actually came from xAI. The detector it
// relies on matches on message text, and text from another back end could
// resemble it, so the provider tag on the error — not the wording — decides.
//
// The OpenAI side answers its typed errors with messages that name no provider
// at all: the user cannot act on which back end GemiX runs, and a message that
// said "Grok" on the ChatGPT profile would simply be wrong.

import { OPENAI_ERROR } from '../openaiResponsesTransport.js';
import { isGrokCreditExhaustedError } from '../apiClient.js';
import {
  GROK_CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_LIMIT_MESSAGE,
  PROVIDER_AUTH_MESSAGE
} from '../../config/systemMessages.js';
import { PROVIDER } from './providerProfile.js';

/** Typed OpenAI failures that have something specific to say to the user. */
const OPENAI_USER_MESSAGES = {
  [OPENAI_ERROR.SUBSCRIPTION_LIMIT]: PROVIDER_LIMIT_MESSAGE,
  [OPENAI_ERROR.RATE_LIMIT]: PROVIDER_LIMIT_MESSAGE,
  [OPENAI_ERROR.AUTH]: PROVIDER_AUTH_MESSAGE
};

/**
 * The reply for a turn that died at the provider, or null when the failure is
 * not one the user should be told about specifically (the caller then sends its
 * generic fallback and logs the error).
 *
 * @param {unknown} err
 * @param {object} profile - the turn's ProviderProfile
 * @returns {{ text: string, logLine: string }|null}
 */
function providerFailureReply(err, profile) {
  if (profile?.id === PROVIDER.OPENAI) {
    if (err?.provider !== 'openai') return null;
    const text = OPENAI_USER_MESSAGES[err.kind];
    if (!text) return null;
    return { text, logLine: `${profile.displayName} refused the turn (${err.kind}) — replying with the neutral notice.` };
  }

  // xAI: the credit notice is for this branch only, and only for its own errors.
  if (err?.provider === 'openai') return null;
  if (!isGrokCreditExhaustedError(err)) return null;
  return {
    text: GROK_CREDIT_EXHAUSTED_MESSAGE,
    logLine: 'Grok credits exhausted — replying with the credit notice (admin not notified).'
  };
}

export { providerFailureReply };
