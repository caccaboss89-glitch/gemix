// test/privacy-wipe-clear.test.js
//
// The wipe command must never confirm a clear that did not happen, and nothing
// from before a wipe may reach a later turn.
//
// WhatsApp Web once let whatsapp-web.js's chat.clearMessages() resolve true
// while every message stayed in the chat, and the next turns read them back.
// So the clear is judged by what the page re-reads afterwards, and the history
// window drops whatever predates the wipe on its own, whatever WhatsApp still
// holds. The in-page clear runs here for real, against a stand-in for the
// WhatsApp Web modules it calls.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';

import constants from '../src/config/constants.js';
import { clearChatInPage } from '../src/platforms/whatsapp/chatClear.js';
import { WINDOW_FETCH_LIMIT, fetchWhatsAppMessageWindow } from '../src/platforms/whatsapp/messageWindow.js';
import { wipeWhatsAppUserData } from '../src/utils/privacyWipe.js';
import { getWipeCutoff, setWipeCutoff } from '../src/utils/wipeCutoffs.js';

const CUTOFF_FILE = path.join(constants.DATA_DIR, 'wipeCutoffs.json');
const END_OF_HISTORY = 1;

let cutoffBackup = null;

before(() => {
  try { cutoffBackup = fs.readFileSync(CUTOFF_FILE, 'utf-8'); }
  catch { cutoffBackup = null; }
});

after(() => {
  if (cutoffBackup !== null) fs.writeFileSync(CUTOFF_FILE, cutoffBackup);
  else fs.rmSync(CUTOFF_FILE, { force: true });
});

afterEach(() => {
  delete globalThis.window;
});

/** A WhatsApp Web model message. */
function pageMessage(t, isNotification = false) {
  return { t, isNotification };
}

/** A whatsapp-web.js Message. */
function message(id, timestamp) {
  return { id: { _serialized: id }, timestamp };
}

/**
 * Stand in for the WhatsApp Web modules the in-page clear calls, and return a
 * page whose evaluate runs the function it is given right here.
 *
 * @param {object} opts
 * @param {string} opts.chatId - the one chat the page knows
 * @param {object[]} opts.loaded - messages loaded in the chat
 * @param {object[]} [opts.stored] - earlier messages only in storage, returned by one loadEarlierMsgs call
 * @param {boolean} [opts.clearWorks] - whether finalizeClearChat really removes them
 * @param {Error} [opts.requestError] - failure of the clear request itself
 */
function fakeWhatsAppWeb({ chatId, loaded, stored = [], clearWorks = true, requestError = null }) {
  const state = { finalized: 0, earlierLoads: 0 };
  const chat = {
    unreadCount: 0,
    endOfHistoryTransferType: 0,
    msgs: { list: [...loaded], getModelsArray() { return this.list; } }
  };
  let earlier = [...stored];
  const modules = {
    WAWebStateUtils: { unproxy: (model) => model },
    WAWebClearChatUtils: {
      initClearChat: () => (requestError ? Promise.reject(requestError) : Promise.resolve({ result: [] })),
      // Like the real one: it releases the pending clear whatever happened, and
      // rethrows the request's failure.
      finalizeClearChat: async (model, pending) => {
        state.finalized += 1;
        await pending;
        if (clearWorks) {
          model.msgs.list = [];
          earlier = [];
        }
      }
    },
    WAWebChatConstants: {
      ConversationEndOfHistoryTransferModelPropType: { COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY: END_OF_HISTORY }
    },
    WAWebMsgGetters: { getIsNotification: (msg) => msg.isNotification },
    WAWebChatLoadMessages: {
      loadEarlierMsgs: async () => {
        state.earlierLoads += 1;
        const batch = earlier;
        earlier = [];
        return batch;
      }
    }
  };
  globalThis.window = {
    WWebJS: { getChat: async (id) => (id === chatId ? chat : undefined) },
    require: (name) => modules[name]
  };
  return { chat, state, page: { evaluate: async (fn, ...args) => fn(...args) } };
}

test('a clear that really empties the chat passes, and stops on-demand reloads', async () => {
  const { chat, state, page } = fakeWhatsAppWeb({
    chatId: 'clear-ok@c.us',
    loaded: [pageMessage(100), pageMessage(200)],
    stored: [pageMessage(50)]
  });
  assert.equal(await clearChatInPage(page, 'clear-ok@c.us', 300), true);
  assert.equal(chat.endOfHistoryTransferType, END_OF_HISTORY);
  assert.equal(state.finalized, 1);
});

test('a clear that leaves the messages in place is not a clear', async () => {
  const { page } = fakeWhatsAppWeb({
    chatId: 'clear-stale@c.us',
    loaded: [pageMessage(100), pageMessage(200)],
    clearWorks: false
  });
  assert.equal(await clearChatInPage(page, 'clear-stale@c.us', 300), false);
});

test('messages left only in storage still count against the clear', async () => {
  const { state, page } = fakeWhatsAppWeb({
    chatId: 'clear-storage@c.us',
    loaded: [pageMessage(300)],
    stored: [pageMessage(100)],
    clearWorks: false
  });
  assert.equal(await clearChatInPage(page, 'clear-storage@c.us', 250), false);
  assert.equal(state.earlierLoads, 1);
});

test('later messages and the encryption notice a clear keeps do not count against it', async () => {
  const { page } = fakeWhatsAppWeb({
    chatId: 'clear-later@c.us',
    loaded: [pageMessage(100, true), pageMessage(300)],
    clearWorks: false
  });
  assert.equal(await clearChatInPage(page, 'clear-later@c.us', 300), true);
});

test('a failed clear request fails the clear and still releases it for the next one', async () => {
  const { chat, state, page } = fakeWhatsAppWeb({
    chatId: 'clear-error@c.us',
    loaded: [pageMessage(100)],
    requestError: new Error('request refused')
  });
  await assert.rejects(clearChatInPage(page, 'clear-error@c.us', 300), /request refused/);
  assert.equal(state.finalized, 1);
  assert.equal(chat.endOfHistoryTransferType, 0);
});

test('a chat the page does not know is not cleared', async () => {
  const { page } = fakeWhatsAppWeb({ chatId: 'clear-known@c.us', loaded: [] });
  assert.equal(await clearChatInPage(page, 'clear-unknown@c.us', 300), false);
});

test('a wipe whose clear left messages fails, yet hides them from later turns', async () => {
  const chatId = 'wipe-stale-test@c.us';
  const earlier = Math.floor(Date.now() / 1000) - 60;
  const { page } = fakeWhatsAppWeb({
    chatId,
    loaded: [pageMessage(earlier), pageMessage(earlier + 1)],
    clearWorks: false
  });
  const chat = {
    id: { _serialized: chatId },
    client: { pupPage: page },
    fetchMessages: async () => [message('old-1', earlier), message('old-2', earlier + 1)]
  };

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

/** A chat whose WhatsApp copy is exactly `messages`. */
function windowChat(chatId, messages) {
  return { id: { _serialized: chatId }, fetchMessages: async ({ limit }) => messages.slice(-limit) };
}

test('the window drops what predates the wipe and keeps what follows it', async () => {
  const chatId = 'window-cutoff@c.us';
  await setWipeCutoff(chatId, 200);
  const chat = windowChat(chatId, [message('before', 199), message('clear-reply', 200), message('after', 250)]);

  const { windowMessages, recentMessageIds } = await fetchWhatsAppMessageWindow(chat);
  assert.deepEqual(windowMessages.map(m => m.id._serialized), ['clear-reply', 'after']);
  assert.deepEqual([...recentMessageIds], ['clear-reply', 'after']);
  assert.equal(getWipeCutoff(chatId), 200, 'a window that still reaches back to the wipe keeps the cutoff');
});

test('the cutoff goes once a full window holds only later messages', async () => {
  const chatId = 'window-prune@c.us';
  await setWipeCutoff(chatId, 200);
  const later = Array.from({ length: WINDOW_FETCH_LIMIT }, (_, i) => message(`m${i}`, 300 + i));
  const chat = windowChat(chatId, [message('before', 100), ...later]);

  const { windowMessages } = await fetchWhatsAppMessageWindow(chat);
  assert.equal(windowMessages.length, constants.MAX_HISTORY);
  assert.equal(getWipeCutoff(chatId), null);
});
