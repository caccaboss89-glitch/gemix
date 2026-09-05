import assert from 'node:assert/strict';
import test from 'node:test';

import { _projectionStorageName } from '../src/tools/sentMessagesReader.js';

test('sent-message projection names are stable and isolate equal display names', () => {
  const first = _projectionStorageName(
    { id: 'message-a' },
    { originalName: 'report.pdf', storedFile: 'one_report.pdf' }
  );
  const repeated = _projectionStorageName(
    { id: 'message-a' },
    { originalName: 'report.pdf', storedFile: 'one_report.pdf' }
  );
  const second = _projectionStorageName(
    { id: 'message-b' },
    { originalName: 'report.pdf', storedFile: 'two_report.pdf' }
  );

  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(first, /report\.pdf$/);
});

test('legacy records remain isolated by their retained storage token', () => {
  assert.notEqual(
    _projectionStorageName({}, { originalName: 'same.txt', storedFile: 'old-a_same.txt' }),
    _projectionStorageName({}, { originalName: 'same.txt', storedFile: 'old-b_same.txt' })
  );
});
