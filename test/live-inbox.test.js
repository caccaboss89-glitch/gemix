// test/live-inbox.test.js
//
// Messages that reach a chat while its turn is running. The invariants that
// matter: a held message is shown once and only to the turn it belongs to, the
// hold is bounded, and the lines read exactly like the history's.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LIVE_MESSAGES,
  clearLiveMessages,
  drainLiveMessages,
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
    recordLiveMessage(key, { userName: 'Spam', text: `msg ${i}`, timestampMs: AT });
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

test('recording without a chat key holds nothing', () => {
  assert.equal(recordLiveMessage(null, { userName: 'X', text: 'y' }), 0);
  assert.deepEqual(drainLiveMessages(undefined), { messages: [], overflow: 0 });
});
