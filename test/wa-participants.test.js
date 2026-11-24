// test/wa-participants.test.js
//
// The roster of a WhatsApp group in the prompt: it names the admin whenever
// they are in the group, whoever is writing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVE_MEMBERS } from '../src/config/members.js';
import { setReadyDedicatedClient } from '../src/platforms/whatsapp/dedicatedClientRegistry.js';
import { buildGroupParticipants, formatParticipantsForPrompt } from '../src/utils/waParticipants.js';

function fakeGroup(entries) {
  const contacts = new Map(entries.map(e => [e.jid, e]));
  setReadyDedicatedClient({
    info: { wid: { user: '390000000009' } },
    getContactById: async jid => contacts.get(jid),
    getContactLidAndPhone: async () => []
  });
  return { participants: entries.map(e => ({ id: { _serialized: e.jid, server: 'c.us', user: e.number } })) };
}

test('the group roster marks the admin and nobody else', async (t) => {
  const original = [...ACTIVE_MEMBERS];
  t.after(() => {
    ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length, ...original);
    setReadyDedicatedClient(null);
  });
  ACTIVE_MEMBERS.splice(0, ACTIVE_MEMBERS.length,
    { name: 'Test Admin', nicks: ['a'], email: 'a@example.invalid', wa: '390000000001@c.us', admin: true },
    { name: 'Test Member', nicks: ['m'], email: 'm@example.invalid', wa: '390000000002@c.us' });

  const chat = fakeGroup([
    { jid: '390000000001@c.us', number: '390000000001', pushname: 'Boss' },
    { jid: '390000000002@c.us', number: '390000000002', pushname: 'Mem' },
    { jid: '390000000003@c.us', number: '390000000003', pushname: 'Stranger' }
  ]);
  const roster = await buildGroupParticipants(chat);
  assert.deepEqual(
    roster.filter(p => p.isAdmin).map(p => p.number),
    ['390000000001']
  );
  assert.equal(roster.find(p => p.isGemix).isAdmin, false);
  assert.equal(
    formatParticipantsForPrompt(roster),
    'Boss (the admin, who created GemiX): 390000000001, Mem: 390000000002, Stranger: 390000000003, '
      + 'GemiX (you, never tag yourself): 390000000009'
  );

  const without = fakeGroup([{ jid: '390000000003@c.us', number: '390000000003', pushname: 'Stranger' }]);
  assert.ok(!(await buildGroupParticipants(without)).some(p => p.isAdmin));
});
