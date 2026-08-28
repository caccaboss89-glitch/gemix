import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';

import envConfig from '../src/config/env.js';
import {
  CARTESIA_STATE_FILE,
  markExhausted,
  markWorking,
  nextUsableKey
} from '../src/media/cartesiaKeyRing.js';
import {
  TTS_VOICES,
  cartesiaLanguage,
  cartesiaVoiceId,
  edgeVoice,
  normalizeVoice
} from '../src/media/ttsVoices.js';
import { getRomeISO } from '../src/utils/time.js';

const RING = ['test-key-alpha', 'test-key-beta', 'test-key-gamma'];

let stateBackup = null;
let keysBackup = null;

before(() => {
  try { stateBackup = fs.readFileSync(CARTESIA_STATE_FILE, 'utf-8'); }
  catch { stateBackup = null; }
  keysBackup = envConfig.CARTESIA_API_KEYS;
});

after(() => {
  envConfig.CARTESIA_API_KEYS = keysBackup;
  if (stateBackup === null) { try { fs.unlinkSync(CARTESIA_STATE_FILE); } catch { /* never existed */ } }
  else fs.writeFileSync(CARTESIA_STATE_FILE, stateBackup);
});

beforeEach(() => {
  envConfig.CARTESIA_API_KEYS = [...RING];
  try { fs.unlinkSync(CARTESIA_STATE_FILE); } catch { /* already absent */ }
});

function writeState(state) {
  fs.writeFileSync(CARTESIA_STATE_FILE, JSON.stringify(state));
}

function readState() {
  return JSON.parse(fs.readFileSync(CARTESIA_STATE_FILE, 'utf-8'));
}

// -- key rotation ------------------------------------------------------------

test('a fresh ring starts on the first configured key and stays on the working one', async () => {
  const first = nextUsableKey();
  assert.equal(first.key, RING[0]);

  // A restart must resume on the key that last produced audio, not re-probe.
  await markWorking(first.fingerprint);
  assert.equal(nextUsableKey().key, RING[0]);

  const second = await markExhausted(first.fingerprint);
  assert.equal(second.key, RING[1]);
  await markWorking(second.fingerprint);
  assert.equal(nextUsableKey().key, RING[1]);
});

test('the ring falls through to nothing once every key is spent this month', async () => {
  let entry = nextUsableKey();
  while (entry) entry = await markExhausted(entry.fingerprint);

  assert.equal(nextUsableKey(), null);
  assert.deepEqual(Object.values(readState().exhausted), Array(RING.length).fill(getRomeISO().slice(0, 7)));
});

test('a key spent in an earlier month is eligible again, and the state drops the stale stamp', async () => {
  let entry = nextUsableKey();
  while (entry) entry = await markExhausted(entry.fingerprint);

  const stale = readState();
  for (const fingerprint of Object.keys(stale.exhausted)) stale.exhausted[fingerprint] = '2020-01';
  writeState(stale);

  // The monthly allowance has reset, so the ring probes from the top again.
  assert.equal(nextUsableKey().key, RING[0]);

  await markExhausted(nextUsableKey().fingerprint);
  assert.deepEqual(Object.values(readState().exhausted), [getRomeISO().slice(0, 7)]);
});

test('a ring with no configured key has nothing to hand out', () => {
  envConfig.CARTESIA_API_KEYS = [];
  assert.equal(nextUsableKey(), null);
});

test('adding a key to the pool mid-month leaves the recorded ones alone', async () => {
  const spent = nextUsableKey();
  await markExhausted(spent.fingerprint);

  envConfig.CARTESIA_API_KEYS = [...RING, 'test-key-delta'];
  assert.equal(nextUsableKey().key, RING[1]);
  assert.equal(Object.keys(readState().exhausted).length, 1);
});

// -- voice mapping -----------------------------------------------------------

test('the two voices map to one Cartesia id and one Edge voice each', () => {
  assert.deepEqual(TTS_VOICES, ['male', 'female']);
  assert.notEqual(cartesiaVoiceId('male'), cartesiaVoiceId('female'));
  assert.deepEqual(edgeVoice('male', 'it'), { voice: 'it-IT-DiegoNeural', lang: 'it-IT' });
  assert.deepEqual(edgeVoice('female', 'it'), { voice: 'it-IT-ElsaNeural', lang: 'it-IT' });
});

test('an unknown voice or language degrades to the deployment defaults', () => {
  assert.equal(normalizeVoice('sirius'), 'male');
  assert.equal(cartesiaVoiceId('sirius'), cartesiaVoiceId('male'));
  assert.deepEqual(edgeVoice('female', 'xx'), edgeVoice('female', 'it'));
});

test('Cartesia takes the base language code behind a regional reply language', () => {
  assert.equal(cartesiaLanguage('pt-BR'), 'pt');
  assert.equal(cartesiaLanguage('es-MX'), 'es');
  assert.equal(cartesiaLanguage('it'), 'it');
});

test('every reply language keeps a distinct Edge voice per gender', () => {
  const languages = [
    'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it',
    'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'es-MX', 'es-ES', 'tr', 'vi'
  ];
  for (const language of languages) {
    const male = edgeVoice('male', language);
    const female = edgeVoice('female', language);
    assert.notEqual(male.voice, female.voice, `${language} reuses one voice for both genders`);
    assert.ok(male.voice.startsWith(male.lang), `${language} male voice does not match its locale`);
    assert.ok(female.voice.startsWith(female.lang), `${language} female voice does not match its locale`);
  }
});
