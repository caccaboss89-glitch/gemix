import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceOccurrence,
  advanceOccurrenceBeyond,
  normalizePersistedRecurrence,
  parseRecurrenceRule
} from '../src/utils/recurrence.js';

test('EXDATE accepts only real calendar dates', () => {
  assert.equal(parseRecurrenceRule('FREQ=DAILY;EXDATE=2028-02-29').ok, true);
  assert.equal(parseRecurrenceRule('FREQ=DAILY;EXDATE=').ok, false);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10']) {
    const parsed = parseRecurrenceRule(`FREQ=DAILY;EXDATE=${value}`);
    assert.equal(parsed.ok, false, value);
    assert.match(parsed.error, /Invalid EXDATE value/);
  }
});

test('hourly recurrence can cross more than 1000 excluded candidates', () => {
  const excluded = [];
  for (let day = 1; day <= 46; day++) {
    excluded.push(new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10));
  }
  const recurrence = {
    freq: 'HOURLY',
    interval: 1,
    byday: [],
    exdate: excluded,
    until: '2027-01-01T00:00:00+01:00'
  };
  assert.equal(
    advanceOccurrence('2026-01-01T00:00:00+01:00', recurrence),
    '2026-02-16T00:00:00+01:00'
  );
});

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

test('a daily recurrence skips the nonexistent Rome spring hour without ending', () => {
  const recurrence = { freq: 'DAILY', interval: 1, byday: [], exdate: [], until: null };
  assert.equal(
    advanceOccurrence('2026-03-28T02:30:00+01:00', recurrence),
    '2026-03-30T02:30:00+02:00'
  );
});

test('an ambiguous Rome autumn hour uses the second standard-time occurrence', () => {
  const recurrence = { freq: 'DAILY', interval: 1, byday: [], exdate: [], until: null };
  assert.equal(
    advanceOccurrence('2026-10-24T02:30:00+02:00', recurrence),
    '2026-10-25T02:30:00+01:00'
  );
});

test('hourly recurrences preserve elapsed time across both DST transitions', () => {
  const recurrence = { freq: 'HOURLY', interval: 1, byday: [], exdate: [], until: null };

  const firstAutumnHour = advanceOccurrence('2026-10-25T01:30:00+02:00', recurrence);
  assert.equal(firstAutumnHour, '2026-10-25T02:30:00+02:00');
  const secondAutumnHour = advanceOccurrence(firstAutumnHour, recurrence);
  assert.equal(secondAutumnHour, '2026-10-25T02:30:00+01:00');
  assert.equal(
    advanceOccurrence(secondAutumnHour, recurrence),
    '2026-10-25T03:30:00+01:00'
  );

  assert.equal(
    advanceOccurrence('2026-03-29T01:30:00+01:00', recurrence),
    '2026-03-29T03:30:00+02:00'
  );
});

test('monthly recurrences retain the original day after clamping a short month', () => {
  const recurrence = {
    freq: 'MONTHLY',
    interval: 1,
    byday: [],
    exdate: [],
    until: null,
    anchorDay: 31
  };
  const february = advanceOccurrence('2027-01-31T09:00:00+01:00', recurrence);
  assert.equal(february, '2027-02-28T09:00:00+01:00');
  assert.equal(advanceOccurrence(february, recurrence), '2027-03-31T09:00:00+02:00');
});

test('old monthly records derive and preserve an anchor from their stored occurrence', () => {
  assert.equal(
    normalizePersistedRecurrence(
      { freq: 'MONTHLY', interval: 1, until: null },
      '2027-01-31T09:00:00+01:00'
    ).anchorDay,
    31
  );
});
