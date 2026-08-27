import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDSTAmbiguousHour, convertRomeLocalToISO } from '../src/utils/time.js';

test('Rome scheduling preserves the requested wall-clock hour and owns the offset', () => {
  assert.equal(convertRomeLocalToISO('2026-08-27T14:30:00'), '2026-08-27T14:30:00+02:00');
  assert.equal(convertRomeLocalToISO('2026-01-15T14:30:00'), '2026-01-15T14:30:00+01:00');
  assert.equal(convertRomeLocalToISO('2026-08-27T14:30:00.123'), '2026-08-27T14:30:00.123+02:00');
  assert.equal(convertRomeLocalToISO('2026-08-27T14:30:00+02:00'), null);
  assert.equal(convertRomeLocalToISO('2026-08-27T12:30:00Z'), null);
});

test('Rome scheduling rejects impossible calendar dates and spring-forward wall time', () => {
  assert.equal(convertRomeLocalToISO('2026-02-29T12:00:00'), null);
  assert.equal(convertRomeLocalToISO('2026-02-31T12:00:00'), null);
  assert.equal(convertRomeLocalToISO('2026-03-29T02:30:00'), null);
  assert.match(checkDSTAmbiguousHour('2026-03-29T02:30:00'), /^Invalid time:/);
});

test('Rome scheduling chooses the documented second occurrence in the autumn overlap', () => {
  assert.equal(convertRomeLocalToISO('2026-10-25T02:30:00'), '2026-10-25T02:30:00+01:00');
  assert.match(checkDSTAmbiguousHour('2026-10-25T02:30:00'), /second occurrence/);
});
