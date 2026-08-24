import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import constants from '../src/config/constants.js';
import {
  bindGemixVoiceTranscription,
  getUserHistoryPaths,
  storeRecentVoiceText,
  storeUserTranscription,
  syncFileToHistory
} from '../src/utils/historySync.js';

const STORAGE_ID = `history-lock-${process.pid}`;
const CHAT_ID = `history-chat-${process.pid}`;
const { metaFile } = getUserHistoryPaths(STORAGE_ID);

after(() => {
  fs.rmSync(path.join(constants.DATA_DIR, 'users', STORAGE_ID), { recursive: true, force: true });
});

test('all history metadata writers share one read-modify-write lock', async () => {
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });

  const syncing = syncFileToHistory(STORAGE_ID, 'attachment-id', async () => {
    markFetchStarted();
    await fetchGate;
    return Buffer.from('attachment');
  }, 'attachment.txt');

  await fetchStarted;
  const storing = storeUserTranscription(STORAGE_ID, 'voice.ogg', {
    text: 'hello',
    status: 'ok',
    contentHash: 'hash',
    routeId: 'route'
  });
  releaseFetch();

  assert.equal(await syncing, 'attachment.txt');
  assert.equal(await storing, true);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  assert.equal(meta['attachment-id'].filename, 'attachment.txt');
  assert.equal(meta['file:voice.ogg'].userTranscription.text, 'hello');
});

test('one cached GemiX reply can be claimed by only one voice file', async () => {
  const timestamp = Date.now();
  storeRecentVoiceText(CHAT_ID, 'the generated reply', timestamp);
  const results = await Promise.all([
    bindGemixVoiceTranscription(STORAGE_ID, 'first.ogg', CHAT_ID, timestamp),
    bindGemixVoiceTranscription(STORAGE_ID, 'second.ogg', CHAT_ID, timestamp)
  ]);
  assert.deepEqual(results.filter(Boolean), ['the generated reply']);
});
