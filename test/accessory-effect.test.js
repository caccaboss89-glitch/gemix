import assert from 'node:assert/strict';
import test from 'node:test';

import { runAccessoryEffect } from '../src/utils/accessoryEffect.js';

test('an accessory failure is observable without rejecting the primary flow', async () => {
  const warnings = [];
  const result = await runAccessoryEffect(
    async () => { throw new Error('notification unavailable'); },
    { label: 'Progress notification', log: { warn: value => warnings.push(value) } }
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /unavailable/);
  assert.equal(warnings.length, 1);
});
