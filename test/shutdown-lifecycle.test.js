import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetTerminationForTests,
  beginTermination,
  isTerminating
} from '../src/utils/processLifecycle.js';
import { settleWithDeadline } from '../src/utils/shutdownDeadline.js';

test('termination admission closes exactly once', () => {
  _resetTerminationForTests();
  assert.equal(beginTermination(), true);
  assert.equal(beginTermination(), false);
  assert.equal(isTerminating(), true);
  _resetTerminationForTests();
});

test('shutdown cleanup has a hard deadline even when one task never settles', async () => {
  const result = await settleWithDeadline([
    async () => 'done',
    async () => new Promise(() => {})
  ], 10);
  assert.equal(result.timedOut, true);
});
