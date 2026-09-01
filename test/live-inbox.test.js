// test/live-inbox.test.js
//
// Messages that reach a chat while its turn is running. The invariants that
// matter: a held message is shown once and only to the turn it belongs to, the
// hold is bounded, and the lines read exactly like the history's.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LIVE_MESSAGES,
  claimWipeNotice,
  clearLiveMessages,
  drainLiveMessages,
  openLiveInbox,
  recordLiveMessage,
  renderLiveMessages
} from '../src/utils/liveInbox.js';
import { formatLabeledUserContent } from '../src/utils/text.js';
import { wrapNewMessages } from '../src/utils/systemTags.js';

const AT = Date.UTC(2026, 0, 15, 10, 30, 0);

test('a held message renders exactly like a history line', () => {
  const key = 'wa:render@c.us';
  clearLiveMessages(key);
  recordLiveMessage(key, { userName: 'Marco', text: 'wait, the other link', timestampMs: AT });

  const lines = renderLiveMessages(drainLiveMessages(key));
  assert.deepEqual(lines, [formatLabeledUserContent(AT, 'Marco', 'wait, the other link')]);
  assert.match(wrapNewMessages(lines), /^<new-messages>\n.*\n<\/new-messages>$/s);
});

test('draining empties the inbox, so the same message is never shown twice', () => {
  const key = 'wa:once@c.us';
  clearLiveMessages(key);
  recordLiveMessage(key, { userName: 'Ana', text: 'one', timestampMs: AT });

  assert.equal(drainLiveMessages(key).messages.length, 1);
  assert.deepEqual(drainLiveMessages(key), { messages: [], overflow: 0 });
  assert.deepEqual(renderLiveMessages(drainLiveMessages(key)), []);
});

test('each chat holds its own, and clearing one leaves the others', () => {
  clearLiveMessages('wa:a@c.us');
  clearLiveMessages('wa:b@c.us');
  recordLiveMessage('wa:a@c.us', { userName: 'A', text: 'from a', timestampMs: AT });
  recordLiveMessage('wa:b@c.us', { userName: 'B', text: 'from b', timestampMs: AT });

  clearLiveMessages('wa:a@c.us');
  assert.deepEqual(drainLiveMessages('wa:a@c.us').messages, []);
  assert.equal(drainLiveMessages('wa:b@c.us').messages[0].text, 'from b');
});

test('past the cap the extras are counted, not held', () => {
  const key = 'wa:flood@c.us';
  clearLiveMessages(key);
  for (let i = 0; i < MAX_LIVE_MESSAGES + 3; i++) {
    const held = recordLiveMessage(key, { userName: 'Spam', text: `msg ${i}`, timestampMs: AT });
    // The place in the hold, and 0 once there is no place left: the caller logs
    // it as "handed to the running turn", which a counted message was not.
    assert.equal(held, i < MAX_LIVE_MESSAGES ? i + 1 : 0);
  }

  const lines = renderLiveMessages(drainLiveMessages(key));
  assert.equal(lines.length, MAX_LIVE_MESSAGES + 1);
  assert.match(lines[lines.length - 1], /^\(and 3 more/);
});

test('a very long message is truncated so it cannot take over the round', () => {
  const key = 'wa:long@c.us';
  clearLiveMessages(key);
  recordLiveMessage(key, { userName: 'Wall', text: 'x'.repeat(5000), timestampMs: AT });

  const [line] = renderLiveMessages(drainLiveMessages(key));
  assert.ok(line.length < 1200, `line was ${line.length} chars`);
  assert.ok(line.endsWith('…'));
});

test('a message whose only content is a file still says someone wrote', () => {
  const key = 'wa:media@c.us';
  clearLiveMessages(key);
  recordLiveMessage(key, { userName: 'Gio', text: '', hasMedia: true, timestampMs: AT });

  const [line] = renderLiveMessages(drainLiveMessages(key));
  assert.match(line, /Gio: \[sent a file/);
});

test('a text-less message with no file is dropped rather than shown blank', () => {
  const key = 'wa:blank@c.us';
  clearLiveMessages(key);
  recordLiveMessage(key, { userName: 'Nobody', text: '   ', timestampMs: AT });

  assert.deepEqual(renderLiveMessages(drainLiveMessages(key)), []);
});

test('a restricted inbox holds only the speaker the turn is answering', () => {
  const key = 'discord:thread';
  openLiveInbox(key, { onlySenderId: 'u-1' });
  assert.equal(recordLiveMessage(key, { userName: 'Asker', senderId: 'u-1', text: 'also check the date', timestampMs: AT }), 1);
  assert.equal(recordLiveMessage(key, { userName: 'Someone else', senderId: 'u-2', text: 'lol', timestampMs: AT }), 0);
  assert.equal(recordLiveMessage(key, { userName: 'Third', text: 'no id at all', timestampMs: AT }), 0);

  const lines = renderLiveMessages(drainLiveMessages(key));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Asker: also check the date/);
});

test('the restriction outlives the drain, because the turn does', () => {
  const key = 'discord:thread-rounds';
  openLiveInbox(key, { onlySenderId: 'u-1' });
  recordLiveMessage(key, { userName: 'Asker', senderId: 'u-1', text: 'round one', timestampMs: AT });
  assert.equal(drainLiveMessages(key).messages.length, 1);

  // Same turn, next round: the rest of the thread is still not addressing GemiX.
  recordLiveMessage(key, { userName: 'Someone else', senderId: 'u-2', text: 'lol', timestampMs: AT });
  assert.deepEqual(drainLiveMessages(key).messages, []);
  clearLiveMessages(key);
});

test('an unrestricted inbox holds everyone, which is what WhatsApp wants', () => {
  const key = 'wa:group@g.us';
  openLiveInbox(key);
  recordLiveMessage(key, { userName: 'A', senderId: 'u-1', text: 'one', timestampMs: AT });
  recordLiveMessage(key, { userName: 'B', senderId: 'u-2', text: 'two', timestampMs: AT });

  assert.equal(drainLiveMessages(key).messages.length, 2);
});

test('opening an inbox drops whatever the previous turn left', () => {
  const key = 'wa:reopen@c.us';
  recordLiveMessage(key, { userName: 'Old', text: 'from before', timestampMs: AT });
  openLiveInbox(key);
  assert.deepEqual(drainLiveMessages(key).messages, []);
});

test('the wipe notice is claimed once per turn, then again after it ends', () => {
  const key = 'wa:wipe@c.us';
  openLiveInbox(key);
  assert.equal(claimWipeNotice(key), true);
  assert.equal(claimWipeNotice(key), false);
  assert.equal(claimWipeNotice(key), false);

  clearLiveMessages(key);
  assert.equal(claimWipeNotice(key), true, 'the next turn gets its own notice');
  clearLiveMessages(key);
});

test('the wipe notice stays claimed across the rounds of one turn', () => {
  const key = 'wa:wipe-rounds@c.us';
  openLiveInbox(key);
  assert.equal(claimWipeNotice(key), true);
  drainLiveMessages(key);
  assert.equal(claimWipeNotice(key), false, 'a drain must not re-arm the notice');
  clearLiveMessages(key);
});

test('claiming the wipe notice does not disturb the held messages', () => {
  const key = 'wa:wipe-mixed@c.us';
  openLiveInbox(key);
  recordLiveMessage(key, { userName: 'A', text: 'a real message', timestampMs: AT });
  claimWipeNotice(key);

  assert.equal(drainLiveMessages(key).messages.length, 1);
});

test('recording without a chat key holds nothing', () => {
  assert.equal(recordLiveMessage(null, { userName: 'X', text: 'y' }), 0);
  assert.deepEqual(drainLiveMessages(undefined), { messages: [], overflow: 0 });
});
