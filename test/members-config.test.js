import assert from 'node:assert/strict';
import test from 'node:test';

import { _validateMembers } from '../src/config/members.js';

test('member validation reports the index and field for malformed entries', () => {
  const result = _validateMembers([
    { name: 'Good', nicks: [], email: 'good@example.invalid', wa: '1@c.us' },
    { name: 'Bad', nicks: ['ok', 7], email: null, wa: '2@c.us', admin: 'yes' },
    null
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.members, []);
  assert.match(result.errors[0], /members\[1\].*nicks.*email.*admin/);
  assert.match(result.errors[1], /members\[2\].*object/);
});

test('member validation accepts the complete roster shape', () => {
  const result = _validateMembers([
    { name: 'Good', nicks: ['g'], email: 'good@example.invalid', wa: '1@c.us', legal: true }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.members.length, 1);
});
