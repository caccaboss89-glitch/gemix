// src/utils/mediaUsageLimits.js
//
// Per-user WEEKLY generation quota for images, videos and songs.
//
// Limits are enforced per user (active or not); the admin is exempt. Counts
// are persisted via systemState (survive restarts) and reset every Tuesday at
// 16:00 Europe/Rome — the same wall-clock the reminders and sent-message
// timestamps use (DST-aware, never UTC), NOT a fixed offset.
//
// A period is identified by the date of its opening Tuesday (YYYY-MM-DD); when
// a stored record belongs to an older period it is treated as empty (and pruned
// on the next write), so the reset is lazy and needs no scheduler.
//
// Callers reserve a slot up-front (so parallel tool calls in one round cannot
// exceed the cap) and refund it if the generation fails.

const systemState = require('./systemState');
const { getRomeParts } = require('./time');
const { createLogger } = require('./logger');

const log = createLogger('MediaLimits');

/** systemState module key. */
const STATE_MODULE = 'mediaWeeklyUsage';

/** Weekly caps per generation kind. */
const MEDIA_WEEKLY_LIMITS = { image: 5, video: 2, song: 2 };

/** Weekly reset boundary: Tuesday (0 = Sunday) at 16:00 Europe/Rome. */
const RESET_WEEKDAY = 2;
const RESET_HOUR = 16;

/**
 * Stable key for the current weekly period: the date (YYYY-MM-DD, Europe/Rome)
 * of the most recent Tuesday-16:00 boundary at or before now.
 * @returns {string}
 */
function currentPeriodKey() {
  const { year, month, day, hour, weekday } = getRomeParts();
  // Days since the most recent Tuesday (0 when today is Tuesday).
  let daysBack = (weekday - RESET_WEEKDAY + 7) % 7;
  // Before 16:00 on Tuesday the current period still belongs to last Tuesday.
  if (daysBack === 0 && hour < RESET_HOUR) daysBack = 7;
  const anchor = new Date(Date.UTC(year, month - 1, day));
  anchor.setUTCDate(anchor.getUTCDate() - daysBack);
  const y = anchor.getUTCFullYear();
  const m = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const d = String(anchor.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Current-period usage counts for a user (zeros when absent or in a past period).
 * @param {string} userKey
 * @returns {{ image:number, video:number, song:number }}
 */
function getMediaUsage(userKey) {
  const zero = { image: 0, video: 0, song: 0 };
  if (!userKey) return zero;
  const state = systemState.get(STATE_MODULE) || {};
  const rec = state[userKey];
  if (!rec || rec.period !== currentPeriodKey()) return zero;
  return { image: rec.image || 0, video: rec.video || 0, song: rec.song || 0 };
}

/**
 * Format the usage counts for the prompt Limits section.
 * @param {string} userKey
 * @returns {string} e.g. "Video: 1/2 Immagini 3/5 Canzoni 0/2"
 */
function formatQuotaCounts(userKey) {
  const u = getMediaUsage(userKey);
  return `Video: ${u.video}/${MEDIA_WEEKLY_LIMITS.video} `
    + `Immagini ${u.image}/${MEDIA_WEEKLY_LIMITS.image} `
    + `Canzoni ${u.song}/${MEDIA_WEEKLY_LIMITS.song}`;
}

/**
 * User-facing tool error when a weekly cap is reached.
 * @param {'image'|'video'|'song'} kind
 * @returns {string}
 */
function limitReachedError(kind) {
  const label = { image: 'image', video: 'video', song: 'song' }[kind] || kind;
  return `Weekly ${label} generation limit reached (${MEDIA_WEEKLY_LIMITS[kind]} per week). `
    + 'It resets every Tuesday at 16:00.';
}

/**
 * Atomically reserve one slot for `kind` in the current period.
 * @param {'image'|'video'|'song'} kind
 * @param {string} userKey
 * @returns {Promise<{ allowed:boolean, used:number, limit:number }>}
 */
async function reserveMediaQuota(kind, userKey) {
  const limit = MEDIA_WEEKLY_LIMITS[kind];
  if (!Number.isFinite(limit)) throw new Error(`Unknown media kind: ${kind}`);
  const period = currentPeriodKey();
  let outcome = { allowed: false, used: 0, limit };

  await systemState.update(STATE_MODULE, (current) => {
    // Keep only current-period records (prunes stale weeks on write).
    const next = {};
    for (const [k, rec] of Object.entries(current || {})) {
      if (rec && rec.period === period) next[k] = rec;
    }
    const base = next[userKey] || { period, image: 0, video: 0, song: 0 };
    const used = base[kind] || 0;
    if (used >= limit) {
      next[userKey] = base;
      outcome = { allowed: false, used, limit };
      return next;
    }
    next[userKey] = { ...base, period, [kind]: used + 1 };
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
  const period = currentPeriodKey();
  await systemState.update(STATE_MODULE, (current) => {
    const next = { ...(current || {}) };
    const rec = next[userKey];
    if (!rec || rec.period !== period) return next; // rolled over or absent
    const used = rec[kind] || 0;
    if (used <= 0) return next;
    next[userKey] = { ...rec, [kind]: used - 1 };
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
    },
  };
}

module.exports = {
  MEDIA_WEEKLY_LIMITS,
  currentPeriodKey,
  getMediaUsage,
  formatQuotaCounts,
  limitReachedError,
  reserveMediaQuota,
  refundMediaQuota,
  reserveGeneration,
};
