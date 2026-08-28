// src/media/cartesiaKeyRing.js
//
// Which Cartesia API key GemiX speaks with right now.
//
// Cartesia grants each account a monthly free credit allowance, so the
// deployment holds several keys (CARTESIA_API_KEYS) and works through them one
// at a time. A key that reports `quota_exceeded` is written down as spent for
// the current month, and the ring moves on to the next one; when every key is
// spent, TTS falls back to Edge for the rest of the month.
//
// The state is persisted so a restart resumes on the key that was working
// instead of paying a failed request per key to rediscover it.
//
// Cartesia documents the reset as "the first of the month" but publishes
// neither the hour nor the time zone, so eligibility is keyed on the calendar
// month in Europe/Rome: from the first minute of a new Rome month every key is
// eligible again, and the first user message probes the ring once. If the real
// reset has not happened yet that costs one failed request, and the key is
// simply written down as spent for the new month until it does.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { withKeyedLock } from '../utils/keyedLock.js';
import { getRomeISO } from '../utils/time.js';

const log = createLogger('CartesiaKeys');

const STATE_FILE = path.join(constants.DATA_DIR, 'cartesia_keys.json');
const locks = new Map();

/** Calendar month the free allowance is tied to, in the deployment's zone. */
function _currentMonth() {
  return getRomeISO().slice(0, 7);
}

/** Short, non-reversible label for a key, safe to persist and to log. */
function _fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** The configured keys, in .env order, each with its fingerprint. */
function _ring() {
  return envConfig.CARTESIA_API_KEYS.map(key => ({ key, fingerprint: _fingerprint(key) }));
}

function _load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      return {
        active: typeof raw.active === 'string' ? raw.active : null,
        exhausted: raw.exhausted && typeof raw.exhausted === 'object' ? raw.exhausted : {}
      };
    }
  } catch { /* first run, or a corrupted file we are about to replace */ }
  return { active: null, exhausted: {} };
}

function _save(state) {
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    // The ring still works for this process; it just re-probes after a restart.
    log.warn(`Cannot persist the Cartesia key state: ${err.message}`);
  }
}

/** Stamps from earlier months are spent allowances that have since reset. */
function _spentThisMonth(state, month) {
  const spent = new Set();
  for (const [fingerprint, stamp] of Object.entries(state.exhausted)) {
    if (stamp === month) spent.add(fingerprint);
  }
  return spent;
}

/**
 * The key to try next, or null when every configured key is spent for the
 * current month (or none is configured at all). The last key known to work is
 * preferred, so the common case costs no failed request.
 * @returns {{ key: string, fingerprint: string }|null}
 */
function nextUsableKey() {
  const ring = _ring();
  if (ring.length === 0) return null;
  const state = _load();
  const spent = _spentThisMonth(state, _currentMonth());
  const usable = ring.filter(entry => !spent.has(entry.fingerprint));
  if (usable.length === 0) return null;
  return usable.find(entry => entry.fingerprint === state.active) || usable[0];
}

/**
 * Record that a key produced audio, so the next turn starts on it directly.
 * @param {string} fingerprint
 */
async function markWorking(fingerprint) {
  await withKeyedLock(locks, 'cartesia-keys', async () => {
    const state = _load();
    if (state.active === fingerprint) return;
    state.active = fingerprint;
    _save(state);
  });
}

/**
 * Record that a key has spent its monthly allowance, and hand back the next
 * one to try. Stamps from previous months are dropped on the way through, so
 * the file never accumulates keys the deployment has stopped using.
 * @param {string} fingerprint
 * @returns {Promise<{ key: string, fingerprint: string }|null>}
 */
async function markExhausted(fingerprint) {
  await withKeyedLock(locks, 'cartesia-keys', async () => {
    const month = _currentMonth();
    const state = _load();
    const exhausted = {};
    for (const fp of _spentThisMonth(state, month)) exhausted[fp] = month;
    exhausted[fingerprint] = month;
    _save({
      active: state.active === fingerprint ? null : state.active,
      exhausted
    });
  });
  log.info(`Key ${fingerprint} is out of monthly credits; rotating.`);
  return nextUsableKey();
}

export { STATE_FILE as CARTESIA_STATE_FILE, nextUsableKey, markWorking, markExhausted };
