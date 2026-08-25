import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStaticInstructions } from '../src/ai/systemPrompt.js';
import constants from '../src/config/constants.js';

const FIXTURE_MEMBERS = [{
  name: 'Fixture Member',
  wa: '390000000099@c.us',
  email: 'fixture@example.invalid'
}];

function promptFor(isAdmin) {
  return buildStaticInstructions({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'fixture@c.us',
    userName: isAdmin ? 'Test Admin' : 'Fixture Member',
    userIdentity: { isActiveMember: true, isAdmin }
  }, undefined, { activeMembers: FIXTURE_MEMBERS });
}

test('an injected prompt roster preserves admin-only identifiers without using deployment data', () => {
  assert.match(
    promptFor(true),
    /<ActiveMembers>Fixture Member \(390000000099, fixture@example\.invalid\)<\/ActiveMembers>/
  );
  assert.match(promptFor(false), /<ActiveMembers>Fixture Member<\/ActiveMembers>/);
  assert.doesNotMatch(
    promptFor(false),
    /390000000099|fixture@example\.invalid/
  );
});
