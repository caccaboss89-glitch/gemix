// src/utils/mediaUsageLimits.js
//
// Per-user generation quota for images, videos and songs.
//
// The caps do not all run on the same clock: images are cheap and frequently
// asked for, so they get a daily allowance, while videos and songs cost far
// more per generation and stay weekly. Each kind therefore carries its own
// period scale, and a user can be out of images while still having songs left.
//
// Limits are enforced per user (active or not); the admin is exempt. Counts are
// persisted via systemState (survive restarts) and reset at the configured time
// Europe/Rome — daily every day at that time, weekly on the configured weekday
// (env MEDIA_QUOTA_RESET_*; defaults Monday 00:00) — the same wall-clock the
// reminders and sent-message timestamps use (DST-aware, never UTC), NOT a fixed
// offset.
//
// A period is identified by the date of its opening reset (YYYY-MM-DD); when a
// stored count belongs to an older period it is treated as empty (and pruned on
// the next write), so the reset is lazy and needs no scheduler.
//
// Callers reserve a slot up-front (so parallel tool calls in one round cannot
// exceed the cap) and refund it if the generation fails.

import * as systemState from './systemState.js';
import { getRomeParts  } from './time.js';
import { createLogger  } from './logger.js';
import envConfig from '../config/env.js';

const log = createLogger('MediaLimits');

/** systemState module key. */
const STATE_MODULE = 'mediaUsage';

/** Cap per generation kind, each on the period scale that suits its cost. */
const MEDIA_LIMITS = Object.freeze({
  image: { limit: 5, scale: 'day' },
  video: { limit: 2, scale: 'week' },
  song: { limit: 2, scale: 'week' }
});

/** Reset boundary from env (weekday 0=Sun…6=Sat, weekly only; hour/minute Europe/Rome, both scales). */
const RESET_WEEKDAY = envConfig.MEDIA_QUOTA_RESET_WEEKDAY;
const RESET_HOUR = envConfig.MEDIA_QUOTA_RESET_HOUR;
const RESET_MINUTE = envConfig.MEDIA_QUOTA_RESET_MINUTE;
const RESET_MINUTES_OF_DAY = RESET_HOUR * 60 + RESET_MINUTE;

const WEEKDAY_NAMES_EN = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

/**
 * Human label for a reset boundary (prompt + tool errors), Europe/Rome.
 * e.g. "every day at 00:00", "every Monday at 00:00"
 * @param {'day'|'week'} scale
 * @returns {string}
 */
function formatMediaQuotaResetLabel(scale) {
  const when = scale === 'week' ? (WEEKDAY_NAMES_EN[RESET_WEEKDAY] || 'Monday') : 'day';
  const hh = String(RESET_HOUR).padStart(2, '0');
  const mm = String(RESET_MINUTE).padStart(2, '0');
  return `every ${when} at ${hh}:${mm}`;
}

/**
 * Stable key for the current period on one scale: the date (YYYY-MM-DD,
 * Europe/Rome) of the most recent reset boundary at or before now.
 * @param {'day'|'week'} scale
 * @returns {string}
 */
function currentPeriodKey(scale) {
  const { year, month, day, hour, minute, weekday } = getRomeParts();
  // Days since the most recent reset day (0 when today is that day).
  let daysBack = scale === 'week' ? (weekday - RESET_WEEKDAY + 7) % 7 : 0;
  // Before reset time on the reset day the current period still belongs to the previous one.
  const nowMinutes = hour * 60 + minute;
  if (daysBack === 0 && nowMinutes < RESET_MINUTES_OF_DAY) daysBack = scale === 'week' ? 7 : 1;
  const anchor = new Date(Date.UTC(year, month - 1, day));
  anchor.setUTCDate(anchor.getUTCDate() - daysBack);
  const y = anchor.getUTCFullYear();
  const m = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const d = String(anchor.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The period key a kind's counter is stamped with right now. */
function periodKeyFor(kind) {
  return currentPeriodKey(MEDIA_LIMITS[kind].scale);
}

/** One kind's count for a user, zero when absent or stamped with a past period. */
function usedCount(record, kind) {
  const entry = record && record[kind];
  if (!entry || entry.period !== periodKeyFor(kind)) return 0;
  return entry.used || 0;
}

/** Whether any of a user's counters still belongs to its current period. */
function _isCurrent(record) {
  return Object.keys(MEDIA_LIMITS).some(kind => usedCount(record, kind) > 0);
}

/** Drop counters whose period has rolled over, so writes prune stale records. */
function _prune(current) {
  const next = {};
  for (const [key, record] of Object.entries(current || {})) {
    if (!_isCurrent(record)) continue;
    const kept = {};
    for (const kind of Object.keys(MEDIA_LIMITS)) {
      const used = usedCount(record, kind);
      if (used > 0) kept[kind] = { period: periodKeyFor(kind), used };
    }
    next[key] = kept;
  }
  return next;
}

/**
 * Format the usage counts for the Runtime trailer quota line, grouped by the
 * period they reset on so the boundary is stated once per scale.
 * @param {string} userKey
 * @param {Array<'image'|'video'|'song'>} [kinds]
 * @returns {string} e.g. "Immagini: 3/5 (resets every day at 00:00);
 *   Video: 1/2 · Canzoni: 0/2 (resets every Monday at 00:00)"
 */
function formatQuotaCounts(userKey, kinds = ['video', 'image', 'song']) {
  const record = userKey ? (systemState.get(STATE_MODULE) || {})[userKey] : null;
  const labels = { video: 'Video', image: 'Immagini', song: 'Canzoni' };
  const wanted = kinds.filter(kind => Object.hasOwn(MEDIA_LIMITS, kind));
  return ['day', 'week']
    .map(scale => {
      const counts = wanted
        .filter(kind => MEDIA_LIMITS[kind].scale === scale)
        .map(kind => `${labels[kind]}: ${usedCount(record, kind)}/${MEDIA_LIMITS[kind].limit}`)
        .join(' · ');
      return counts ? `${counts} (resets ${formatMediaQuotaResetLabel(scale)})` : '';
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * User-facing tool error when a cap is reached.
 * @param {'image'|'video'|'song'} kind
 * @returns {string}
 */
function limitReachedError(kind) {
  const { limit, scale } = MEDIA_LIMITS[kind];
  const period = scale === 'week' ? 'week' : 'day';
  return `${scale === 'week' ? 'Weekly' : 'Daily'} ${kind} generation limit reached `
    + `(${limit} per ${period}). It resets ${formatMediaQuotaResetLabel(scale)}.`;
}

/**
 * Atomically reserve one slot for `kind` in its current period.
 * @param {'image'|'video'|'song'} kind
 * @param {string} userKey
 * @returns {Promise<{ allowed:boolean, used:number, limit:number }>}
 */
async function reserveMediaQuota(kind, userKey) {
  const spec = MEDIA_LIMITS[kind];
  if (!spec) throw new Error(`Unknown media kind: ${kind}`);
  const { limit } = spec;
  let outcome = { allowed: false, used: 0, limit };

  await systemState.update(STATE_MODULE, (current) => {
    const next = _prune(current);
    const base = next[userKey] || {};
    const used = usedCount(base, kind);
    if (used >= limit) {
      next[userKey] = base;
      outcome = { allowed: false, used, limit };
      return next;
    }
    next[userKey] = { ...base, [kind]: { period: periodKeyFor(kind), used: used + 1 } };
    outcome = { allowed: true, used: used + 1, limit };
    return next;
  });

  return outcome;
}

/**
 * Give back one previously reserved slot (only within the same period).
 * @param {'image'|'video'|'song'} kind
 * @param {string} userKey
 * @returns {Promise<void>}
 */
async function refundMediaQuota(kind, userKey) {
  await systemState.update(STATE_MODULE, (current) => {
    const next = { ...(current || {}) };
    const record = next[userKey];
    const used = usedCount(record, kind);
    if (used <= 0) return next; // rolled over or absent
    next[userKey] = { ...record, [kind]: { period: periodKeyFor(kind), used: used - 1 } };
    return next;
  });
}

/**
 * Drop a user's counters entirely (data wipe). The next generation starts the
 * current period from zero.
 * @param {string} userKey
 * @returns {Promise<void>}
 */
async function clearMediaUsage(userKey) {
  if (!userKey) return;
  await systemState.update(STATE_MODULE, (current) => {
    const next = { ...(current || {}) };
    delete next[userKey];
    return next;
  });
}

/**
 * Reserve a generation slot for a tool call. Admins (and calls without a stable
 * user id) are exempt. Returns a handle: call commit() once the generation
 * succeeds, and always call release() in a finally block — release refunds the
 * slot unless it was committed.
 *
 * @param {'image'|'video'|'song'} kind
 * @param {object} userCtx - { isAdmin, taskFileId }
 * @returns {Promise<{ ok:true, commit:Function, release:Function } | { ok:false, error:string }>}
 */
async function reserveGeneration(kind, userCtx) {
  const noop = { ok: true, commit() {}, async release() {} };
  if (userCtx && userCtx.isAdmin) return noop;

  const userKey = userCtx && userCtx.taskFileId;
  if (!userKey) return noop; // no stable per-user id → do not block

  const res = await reserveMediaQuota(kind, userKey);
  if (!res.allowed) {
    return { ok: false, error: limitReachedError(kind) };
  }

  let committed = false;
  return {
    ok: true,
    commit() { committed = true; },
    async release() {
      if (committed) return;
      try {
        await refundMediaQuota(kind, userKey);
      } catch (err) {
        log.warn(`quota refund failed (${kind}, ${userKey}): ${err.message}`);
      }
    }
  };
}

export {
  formatQuotaCounts,
  clearMediaUsage,
  reserveGeneration
};
