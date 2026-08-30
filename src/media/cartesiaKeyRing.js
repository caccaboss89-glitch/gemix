// src/media/cartesiaKeyRing.js
//
// Which Cartesia API key GemiX speaks with right now.
//
// Cartesia grants each account a monthly free credit allowance, so the
// deployment holds several keys (CARTESIA_API_KEYS) and works through them one
// at a time on the shared rotation in utils/credentialRing.js. A key that
// reports `quota_exceeded` is written down as spent for the current month and
// the ring moves on; when every key is spent, TTS falls back to Edge for the
// rest of the month.
//
// Cartesia documents the reset as "the first of the month" but publishes
// neither the hour nor the time zone, so the period is the calendar month in
// Europe/Rome: from the first minute of a new Rome month every key is eligible
// again, and the first user message probes the ring once. If the real reset has
// not happened yet that costs one failed request, and the key is simply written
// down as spent for the new month until it does.

import path from 'path';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { createCredentialRing } from '../utils/credentialRing.js';
import { getRomeISO } from '../utils/time.js';

const ring = createCredentialRing({
  label: 'Cartesia',
  stateFile: path.join(constants.DATA_DIR, 'cartesia_keys.json'),
  listCredentials: () => envConfig.CARTESIA_API_KEYS,
  identify: key => key,
  periodKey: () => getRomeISO().slice(0, 7)
});

const CARTESIA_STATE_FILE = ring.STATE_FILE;

/**
 * The key to try next, or null when every configured key is spent for the
 * current month (or none is configured at all).
 * @returns {{ key: string, fingerprint: string }|null}
 */
function nextUsableKey() {
  const entry = ring.next();
  return entry ? { key: entry.credential, fingerprint: entry.fingerprint } : null;
}

/**
 * Record that a key produced audio, so the next turn starts on it directly.
 * @param {string} fingerprint
 * @returns {Promise<void>}
 */
function markWorking(fingerprint) {
  return ring.markWorking(fingerprint);
}

/**
 * Record that a key has spent its monthly allowance, and hand back the next one
 * to try.
 * @param {string} fingerprint
 * @returns {Promise<{ key: string, fingerprint: string }|null>}
 */
async function markExhausted(fingerprint) {
  await ring.markExhausted(fingerprint);
  return nextUsableKey();
}

export {
  CARTESIA_STATE_FILE,
  nextUsableKey,
  markWorking,
  markExhausted
};
