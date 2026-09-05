import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIVE_MEMBERS } from '../src/config/members.js';
import {
  _statsCheckCompletedToday,
  _statsRetryDeferred
} from '../src/scheduler/musicWrapMonitor.js';

function useMembers(t, members) {
  const original = [...ACTIVE_MEMBERS];
  t.after(() => ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length, ...original));
  ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length, ...members);
}

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

test('MusicWrap only treats a same-day stats check as complete after all sends', t => {
  const members = [{ wa: 'music-wrap-test-1@c.us' }, { wa: 'music-wrap-test-2@c.us' }];
  useMembers(t, members);
  const today = '2026-09-02';
  const statsTimestamp = '2026-09-02T08:00:00.000Z';
  const sentToday = Object.fromEntries(members.map(member => [member.wa, today]));

  assert.equal(
    _statsCheckCompletedToday({ lastCheckDate: today, lastStatsTimestamp: statsTimestamp, lastSentDate: sentToday }, today, statsTimestamp),
    true
  );
  const incomplete = { ...sentToday };
  delete incomplete[members[0].wa];
  assert.equal(
    _statsCheckCompletedToday({ lastCheckDate: today, lastStatsTimestamp: statsTimestamp, lastSentDate: incomplete }, today, statsTimestamp),
    false
  );
});

test('MusicWrap with no members still requires the current day and stats timestamp', t => {
  useMembers(t, []);
  const today = '2026-09-02';
  const statsTimestamp = '2026-09-02T08:00:00.000Z';
  const state = { lastCheckDate: today, lastStatsTimestamp: statsTimestamp, lastSentDate: {} };

  assert.equal(_statsCheckCompletedToday(state, today, statsTimestamp), true);
  assert.equal(_statsCheckCompletedToday(state, '2026-09-03', statsTimestamp), false);
  assert.equal(_statsCheckCompletedToday(state, today, '2026-09-02T09:00:00.000Z'), false);
  assert.equal(_statsCheckCompletedToday(null, today, statsTimestamp), false);
});
