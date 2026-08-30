// src/utils/credentialRing.js
//
// A pool of interchangeable free-tier credentials, rotated as each one spends
// its allowance.
//
// Two services are used on their free tiers with several accounts behind them —
// Cartesia (monthly credits) and Cloudflare Workers AI (daily neurons) — and
// both need the same three things: try one credential at a time, remember the
// one that works so a restart does not re-probe the pool, and write down the
// spent ones so they are not tried again until the allowance resets.
//
// What differs is only the period the allowance is tied to, so that is the
// parameter: the ring stamps a spent credential with the period key it was
// spent in, and a stamp from an earlier period simply means the allowance has
// since reset. No scheduler and no expiry bookkeeping — the period key rolling
// over IS the reset.
//
// Credentials are identified by a short hash of their own secret material, so
// the state file names no secret and reordering or extending the pool in .env
// never re-labels the entries already recorded.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './logger.js';
import { withKeyedLock } from './keyedLock.js';

/**
 * Build a rotating credential pool.
 *
 * @param {object} spec
 * @param {string} spec.label - service name, for log lines
 * @param {string} spec.stateFile - absolute path of the JSON state file
 * @param {() => Array<*>} spec.listCredentials - the pool, in .env order
 * @param {(credential: *) => string} spec.identify - secret material to fingerprint
 * @param {() => string} spec.periodKey - the allowance period the pool resets on
 * @returns {{
 *   STATE_FILE: string,
 *   usable: () => Array<{ credential: *, fingerprint: string }>,
 *   next: () => ({ credential: *, fingerprint: string }|null),
 *   markWorking: (fingerprint: string) => Promise<void>,
 *   markExhausted: (fingerprint: string) => Promise<{ credential: *, fingerprint: string }|null>
 * }}
 */
function createCredentialRing({ label, stateFile, listCredentials, identify, periodKey }) {
  const log = createLogger(`${label}Keys`);
  const locks = new Map();

  function _ring() {
    return listCredentials().map(credential => ({
      credential,
      fingerprint: crypto.createHash('sha256').update(identify(credential)).digest('hex').slice(0, 12)
    }));
  }

  function _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
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
    const tmp = `${stateFile}.tmp`;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
      // The ring still works for this process; it just re-probes after a restart.
      log.warn(`Cannot persist the ${label} credential state: ${err.message}`);
    }
  }

  /** Stamps from earlier periods are spent allowances that have since reset. */
  function _spentThisPeriod(state, period) {
    const spent = new Set();
    for (const [fingerprint, stamp] of Object.entries(state.exhausted)) {
      if (stamp === period) spent.add(fingerprint);
    }
    return spent;
  }

  /**
   * Every credential still eligible in the current period, in the order to try
   * them: the last one known to work first, then the rest in .env order. Empty
   * when the pool is empty or every credential in it is spent.
   */
  function usable() {
    const ring = _ring();
    if (ring.length === 0) return [];
    const state = _load();
    const spent = _spentThisPeriod(state, periodKey());
    const eligible = ring.filter(entry => !spent.has(entry.fingerprint));
    const active = eligible.findIndex(entry => entry.fingerprint === state.active);
    if (active <= 0) return eligible;
    return [eligible[active], ...eligible.slice(0, active), ...eligible.slice(active + 1)];
  }

  /**
   * The credential to try next, or null when there is none left. The last one
   * known to work is preferred, so the common case costs no failed request.
   */
  function next() {
    return usable()[0] || null;
  }

  /** Record that a credential did the work, so the next turn starts on it. */
  async function markWorking(fingerprint) {
    await withKeyedLock(locks, stateFile, async () => {
      const state = _load();
      if (state.active === fingerprint) return;
      state.active = fingerprint;
      _save(state);
    });
  }

  /**
   * Record that a credential has spent its allowance for the current period,
   * and hand back the next one to try. Stamps from earlier periods are dropped
   * on the way through, so the file never accumulates credentials the
   * deployment has stopped using.
   */
  async function markExhausted(fingerprint) {
    await withKeyedLock(locks, stateFile, async () => {
      const period = periodKey();
      const state = _load();
      const exhausted = {};
      for (const fp of _spentThisPeriod(state, period)) exhausted[fp] = period;
      exhausted[fingerprint] = period;
      _save({
        active: state.active === fingerprint ? null : state.active,
        exhausted
      });
    });
    log.info(`Credential ${fingerprint} has spent its allowance; rotating.`);
    return next();
  }

  return { STATE_FILE: stateFile, usable, next, markWorking, markExhausted };
}

export { createCredentialRing };
