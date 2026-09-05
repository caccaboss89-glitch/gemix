import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIVE_MEMBERS } from '../src/config/members.js';
import {
  _statsCheckCompletedToday,
  _statsRetryDeferred
} from '../src/scheduler/musicWrapMonitor.js';

test('MusicWrap defers stale-stat retries only until the persisted deadline', () => {
  const now = Date.parse('2026-09-02T10:00:00.000Z');
  assert.equal(
    _statsRetryDeferred({ nextRetryAt: '2026-09-02T11:00:00.000Z' }, now),
    true
  );
  assert.equal(
    _statsRetryDeferred({ nextRetryAt: '2026-09-02T09:00:00.000Z' }, now),
    false
  );
  assert.equal(_statsRetryDeferred({ nextRetryAt: 'not-a-date' }, now), false);
});

test('MusicWrap only treats a same-day stats check as complete after all sends', () => {
  const today = '2026-09-02';
  const statsTimestamp = '2026-09-02T08:00:00.000Z';
  const sentToday = Object.fromEntries(ACTIVE_MEMBERS.map(member => [member.wa, today]));

  assert.equal(
    _statsCheckCompletedToday({ lastCheckDate: today, lastStatsTimestamp: statsTimestamp, lastSentDate: sentToday }, today, statsTimestamp),
    true
  );
  const incomplete = { ...sentToday };
  delete incomplete[ACTIVE_MEMBERS[0].wa];
  assert.equal(
    _statsCheckCompletedToday({ lastCheckDate: today, lastStatsTimestamp: statsTimestamp, lastSentDate: incomplete }, today, statsTimestamp),
    false
  );
});
