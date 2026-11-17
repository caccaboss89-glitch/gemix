// test/privacy-wipe-clear.test.js
//
// The wipe command must never confirm a clear that did not happen, and nothing
// from before a wipe may reach a later turn.
//
// WhatsApp Web once let whatsapp-web.js's chat.clearMessages() resolve true
// while every message stayed in the chat, and the next turns read them back.
// So the clear is judged by re-reading the chat, and the history window drops
// whatever predates the wipe on its own, whatever WhatsApp still holds.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import constants from '../src/config/constants.js';
import { clearWhatsAppChat } from '../src/platforms/whatsapp/chatClear.js';
import { fetchWhatsAppMessageWindow } from '../src/platforms/whatsapp/messageWindow.js';
import { wipeWhatsAppUserData } from '../src/utils/privacyWipe.js';
import { getWipeCutoff, setWipeCutoff } from '../src/utils/wipeCutoffs.js';

const CUTOFF_FILE = path.join(constants.DATA_DIR, 'wipeCutoffs.json');
const WINDOW_FETCH_LIMIT = constants.MAX_HISTORY + 5;

let cutoffBackup = null;

before(() => {
  try { cutoffBackup = fs.readFileSync(CUTOFF_FILE, 'utf-8'); }
  catch { cutoffBackup = null; }
});

after(() => {
  if (cutoffBackup !== null) fs.writeFileSync(CUTOFF_FILE, cutoffBackup);
  else fs.rmSync(CUTOFF_FILE, { force: true });
});

function message(id, timestamp) {
  return { id: { _serialized: id }, timestamp };
}

/** A chat whose page clear "succeeds" while `messages` stay exactly as they are. */
function fakeChat(chatId, messages, { knownToPage = true } = {}) {
  const evaluated = [];
  return {
    evaluated,
    id: { _serialized: chatId },
    client: {
      pupPage: {
        evaluate: async (fn, id) => { evaluated.push(id); return knownToPage; }
      }
    },
    fetchMessages: async ({ limit }) => messages.slice(-limit)
  };
}

test('a clear that leaves earlier messages behind is not a clear', async () => {
  const chat = fakeChat('clear-stale@c.us', [message('a', 100), message('b', 200)]);
  assert.equal(await clearWhatsAppChat(chat, 300), false);
  assert.deepEqual(chat.evaluated, ['clear-stale@c.us']);
});

test('a clear that leaves only later messages is a clear', async () => {
  const chat = fakeChat('clear-done@c.us', [message('confirmation', 300)]);
  assert.equal(await clearWhatsAppChat(chat, 300), true);
});

test('a chat the page does not know is not cleared', async () => {
  const chat = fakeChat('clear-unknown@c.us', [], { knownToPage: false });
  assert.equal(await clearWhatsAppChat(chat, 300), false);
});

test('a wipe whose clear left messages fails, yet hides them from later turns', async () => {
  const chatId = 'wipe-stale-test@c.us';
  const earlier = Math.floor(Date.now() / 1000) - 60;
  const chat = fakeChat(chatId, [message('old-1', earlier), message('old-2', earlier + 1)]);

  const { ok, failed } = await wipeWhatsAppUserData({
    chat,
    ctx: { platform: constants.PLATFORM_WA_DEDICATED, isGroup: false, chatId, waJid: chatId },
    taskFileId: 'wipe-stale-test'
  });

  assert.equal(ok, false, 'the user must be told the wipe did not complete');
  assert.deepEqual(failed, ['chat']);
  assert.ok(getWipeCutoff(chatId) > earlier);
  const { windowMessages, recentMessageIds } = await fetchWhatsAppMessageWindow(chat);
  assert.deepEqual(windowMessages, []);
  assert.equal(recentMessageIds.size, 0);
});

test('the window drops what predates the wipe and keeps what follows it', async () => {
  const chatId = 'window-cutoff@c.us';
  await setWipeCutoff(chatId, 200);
  const chat = fakeChat(chatId, [message('before', 199), message('clear-reply', 200), message('after', 250)]);

  const { windowMessages, recentMessageIds } = await fetchWhatsAppMessageWindow(chat);
  assert.deepEqual(windowMessages.map(m => m.id._serialized), ['clear-reply', 'after']);
  assert.deepEqual([...recentMessageIds], ['clear-reply', 'after']);
  assert.equal(getWipeCutoff(chatId), 200, 'a window that still reaches back to the wipe keeps the cutoff');
});

test('the cutoff goes once a full window holds only later messages', async () => {
  const chatId = 'window-prune@c.us';
  await setWipeCutoff(chatId, 200);
  const later = Array.from({ length: WINDOW_FETCH_LIMIT }, (_, i) => message(`m${i}`, 300 + i));
  const chat = fakeChat(chatId, [message('before', 100), ...later]);

  const { windowMessages } = await fetchWhatsAppMessageWindow(chat);
  assert.equal(windowMessages.length, constants.MAX_HISTORY);
  assert.equal(getWipeCutoff(chatId), null);
});
