import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceOccurrenceBeyond } from '../src/utils/recurrence.js';

test('recurrence advancement skips an entire downtime backlog in one pass', () => {
  const result = advanceOccurrenceBeyond(
    '2026-08-17T09:00:00+02:00',
    { freq: 'DAILY', interval: 1, byday: [], exdate: [], until: null },
    new Date('2026-08-24T10:00:00+02:00').getTime()
  );
  assert.equal(result.next, '2026-08-25T09:00:00+02:00');
  assert.equal(result.skipped, 7);
});

test('recurrence advancement still honors excluded dates and the end date', () => {
  const recurrence = {
    freq: 'DAILY',
    interval: 1,
    byday: [],
    exdate: ['2026-08-25'],
    until: '2026-08-26T09:00:00+02:00'
  };
  assert.deepEqual(
    advanceOccurrenceBeyond(
      '2026-08-24T09:00:00+02:00',
      recurrence,
      new Date('2026-08-25T10:00:00+02:00').getTime()
    ),
    { next: '2026-08-26T09:00:00+02:00', skipped: 0 }
  );
  assert.deepEqual(
    advanceOccurrenceBeyond(
      '2026-08-24T09:00:00+02:00',
      recurrence,
      new Date('2026-08-26T10:00:00+02:00').getTime()
    ),
    { next: null, skipped: 1 }
  );
});
