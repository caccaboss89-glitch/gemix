import assert from 'node:assert/strict';
import test from 'node:test';

import { isWaLifecycleRestartError } from '../src/utils/waPuppeteer.js';

test('handled WhatsApp startup failures are recognizable without swallowing unrelated errors', () => {
  assert.equal(isWaLifecycleRestartError('auth timeout'), true);
  assert.equal(isWaLifecycleRestartError(
    new Error('The browser is already running for /home/homelab/bots/GemiX/.wwebjs_auth/session-personal.')
  ), true);
  assert.equal(isWaLifecycleRestartError(new Error('API authentication failed')), false);
  assert.equal(isWaLifecycleRestartError(new Error('unexpected application bug')), false);
});
