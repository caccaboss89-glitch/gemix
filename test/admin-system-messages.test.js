import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_ERROR_PREFIX,
  GROK_CREDIT_EXHAUSTED_MESSAGE,
  PROVIDER_AUTH_MESSAGE,
  PROVIDER_LIMIT_MESSAGE,
  isSystemMessage
} from '../src/config/systemMessages.js';

test('provider and admin notices have distinct non-duplicated current prefixes', () => {
  assert.equal(ADMIN_ERROR_PREFIX, '⚠️ *ERRORE GEMIX —');
  assert.doesNotMatch(GROK_CREDIT_EXHAUSTED_MESSAGE, /ERRORE API|API — API/);
  assert.doesNotMatch(PROVIDER_LIMIT_MESSAGE, /ERRORE API|API — API/);
  assert.doesNotMatch(PROVIDER_AUTH_MESSAGE, /ERRORE API|API — API|è stato avvisato/);
  assert.equal(isSystemMessage(GROK_CREDIT_EXHAUSTED_MESSAGE), true);
  assert.equal(isSystemMessage(PROVIDER_LIMIT_MESSAGE), true);
  assert.equal(isSystemMessage(PROVIDER_AUTH_MESSAGE), true);
});

test('the old API alert prefix remains recognized for history only', () => {
  assert.equal(isSystemMessage('⚠️ *ERRORE API — Tool*\n\nlegacy'), true);
});
