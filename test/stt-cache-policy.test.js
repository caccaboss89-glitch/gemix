// test/stt-cache-policy.test.js
//
// Transcripts depend on the bytes, the configured backend chain and the
// language hint. Only outcomes that will be identical on a retry belong in
// either the voice-history cache or the read_file parser cache.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after } from 'node:test';
import constants from '../src/config/constants.js';
import { _cacheParameters } from '../src/parsers/parserRegistry.js';
import {
  STT_STATUS,
  isCacheableSttStatus,
  sttModelId,
  sttRouteId
} from '../src/media/speechToText.js';
import {
  getStoredUserTranscription,
  getUserHistoryPaths,
  storeUserTranscription
} from '../src/utils/historySync.js';

const STORAGE_ID = `stt-cache-${process.pid}@c.us`;
const NAME = 'sample.ogg';
const { historyDir } = getUserHistoryPaths(STORAGE_ID);

after(() => {
  fs.rmSync(`${constants.DATA_DIR}/users/${STORAGE_ID}`, { recursive: true, force: true });
});

test('read_file cache parameters include normalized language and the complete STT route', () => {
  const italian = _cacheParameters('audio', '.ogg', { language: ' IT-it ' });
  const english = _cacheParameters('audio', '.ogg', { language: 'en-US' });
  assert.equal(italian.language, 'it-it');
  assert.equal(italian.sttRoute, sttRouteId());
  assert.notDeepEqual(italian, english);

  const document = _cacheParameters('document', '.pdf', {});
  assert.equal('language' in document, false);
  assert.equal('sttRoute' in document, false);
});

test('voice-history cache hits only the exact bytes, route and language', () => {
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(`${historyDir}/${NAME}`, Buffer.from('audio'));
  assert.equal(storeUserTranscription(STORAGE_ID, NAME, {
    text: 'ciao',
    status: STT_STATUS.OK,
    contentHash: 'hash-a',
    routeId: 'route-a',
    language: 'it-it'
  }), true);

  assert.deepEqual(getStoredUserTranscription(STORAGE_ID, NAME, {
    contentHash: 'hash-a', routeId: 'route-a', language: 'it-it'
  }), { text: 'ciao', status: STT_STATUS.OK });
  assert.equal(getStoredUserTranscription(STORAGE_ID, NAME, {
    contentHash: 'hash-b', routeId: 'route-a', language: 'it-it'
  }), null);
  assert.equal(getStoredUserTranscription(STORAGE_ID, NAME, {
    contentHash: 'hash-a', routeId: 'route-b', language: 'it-it'
  }), null);
  assert.equal(getStoredUserTranscription(STORAGE_ID, NAME, {
    contentHash: 'hash-a', routeId: 'route-a', language: 'en-us'
  }), null);
});

test('transient STT outcomes are retried while deterministic outcomes are cacheable', () => {
  for (const status of [STT_STATUS.OK, STT_STATUS.NO_SPEECH, STT_STATUS.TOO_LONG, STT_STATUS.CONTENT_POLICY]) {
    assert.equal(isCacheableSttStatus(status), true, status);
  }
  for (const status of [STT_STATUS.TIMEOUT, STT_STATUS.ERROR, STT_STATUS.UNCONFIGURED]) {
    assert.equal(isCacheableSttStatus(status), false, status);
  }
});

test('the stored model id identifies the backend that actually answered', () => {
  assert.notEqual(sttModelId('xai-stt'), sttModelId('cloudflare-whisper'));
  assert.match(sttModelId('xai-stt'), /^xai:/);
});
