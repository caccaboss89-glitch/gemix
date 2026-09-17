import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_ERROR_PREFIX,
  CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_AUTH_MESSAGE,
  PROVIDER_LIMIT_MESSAGE,
  isSystemMessage
} from '../src/config/systemMessages.js';
import { providerFailureReply } from '../src/ai/providers/errorPolicy.js';
import { TRANSPORT_ERROR, TransportError } from '../src/ai/transport/errors.js';

test('provider and admin notices have distinct non-duplicated current prefixes', () => {
  assert.equal(ADMIN_ERROR_PREFIX, '⚠️ *ERRORE GEMIX —');
  assert.doesNotMatch(CREDIT_EXHAUSTED_MESSAGE, /ERRORE API|API — API/);
  assert.doesNotMatch(PROVIDER_LIMIT_MESSAGE, /ERRORE API|API — API/);
  assert.doesNotMatch(PROVIDER_AUTH_MESSAGE, /ERRORE API|API — API|è stato avvisato/);
  assert.equal(isSystemMessage(CREDIT_EXHAUSTED_MESSAGE), true);
  assert.equal(isSystemMessage(PROVIDER_LIMIT_MESSAGE), true);
  assert.equal(isSystemMessage(PROVIDER_AUTH_MESSAGE), true);
});

test('every provider quota failure uses the shared GemiX credit notice', () => {
  const quota = new TransportError(TRANSPORT_ERROR.QUOTA, 'allowance spent');
  for (const profile of [
    { id: 'chatgpt', displayName: 'ChatGPT' },
    { id: 'xai', displayName: 'Grok' },
    { id: 'custom', displayName: 'Custom' }
  ]) {
    const reply = providerFailureReply(quota, profile);
    assert.equal(reply.text, CREDIT_EXHAUSTED_MESSAGE);
    assert.equal(reply.notifyAdmin, false);
  }
});

test('the old API alert prefix remains recognized for history only', () => {
  assert.equal(isSystemMessage('⚠️ *ERRORE API — Tool*\n\nlegacy'), true);
  assert.equal(isSystemMessage('⚠️ *LIMITE MODELLO — Grok*\n\nlegacy'), true);
});
