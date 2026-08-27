import assert from 'node:assert/strict';
import test from 'node:test';

import { formatStats } from '../src/tools/musicStats.js';

test('music statistics preserve valid zero counters', () => {
  const result = formatStats({
    users: {},
    global: { songsStarted: 0, songsCompleted: 0 }
  });

  assert.equal(result.success, true);
  assert.match(result.message, /Songs started: 0/);
  assert.match(result.message, /Songs completed: 0/);
  assert.doesNotMatch(result.message, /Songs (?:started|completed): N\/A/);
});
