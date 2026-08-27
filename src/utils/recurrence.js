// src/utils/recurrence.js
//
// Recurrence model for scheduled reminders, expressed with a compact RRULE
// string (RFC 5545 subset) so the model writes one short parameter instead of a
// nested object:
//
//   FREQ=DAILY;INTERVAL=2                      every 2 days
//   FREQ=WEEKLY;BYDAY=MO,WE,FR                 every Monday, Wednesday, Friday
//   FREQ=MONTHLY;INTERVAL=3;UNTIL=2027-01-01   every 3 months, until a date
//   FREQ=DAILY;EXDATE=2026-08-15,2026-08-16    daily, skipping two dates
//
// Supported keys: FREQ (HOURLY|DAILY|WEEKLY|MONTHLY), INTERVAL, UNTIL, BYDAY
// (weekly only), EXDATE. Parsing yields a normalized object persisted on the
// task; the engine advances occurrences from it, keeping the original
// Europe/Rome wall-clock time across DST transitions.
//
// Used by:
//   - tools/scheduler.js  (parse + validate the rule the AI wrote)
//   - scheduler/engine.js (advance a due recurring task to its next run)
//   - tools/taskReader.js (render a human-readable recurrence label)

import constants from '../config/constants.js';
import { convertRomeLocalToISO, formatRomeInstantISO, getRomeParts  } from './time.js';

const VALID_FREQS = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];
const MAX_RECURRENCE_STEPS = constants.RECURRENCE_MAX_INTERVAL;

/** RRULE weekday codes, indexed like Date#getUTCDay (0 = Sunday). */
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const FREQ_WORDS = {
  en: {
    HOURLY: ['hour', 'hours'],
    DAILY: ['day', 'days'],
    WEEKLY: ['week', 'weeks'],
    MONTHLY: ['month', 'months']
  },
  it: {
    HOURLY: ['ora', 'ore'],
    DAILY: ['giorno', 'giorni'],
    WEEKLY: ['settimana', 'settimane'],
    MONTHLY: ['mese', 'mesi']
  }
};

const WEEKDAY_NAMES = {
  en: { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' },
  it: { SU: 'dom', MO: 'lun', TU: 'mar', WE: 'mer', TH: 'gio', FR: 'ven', SA: 'sab' }
};

/**
 * Parse a compact RRULE string into a normalized recurrence object.
 * UNTIL is returned as the raw local value; the caller converts and range-checks
 * it (it shares the 1-year limit with the task start date).
 *
 * @param {string} rule
 * @returns {{ ok: true, value: { freq: string, interval: number, byday: string[], exdate: string[], until: string|null } }
 *          | { ok: false, error: string }}
 */
function parseRecurrenceRule(rule) {
  if (typeof rule !== 'string' || !rule.trim()) {
    return { ok: false, error: 'Recurrence rule is empty. Use e.g. "FREQ=DAILY;INTERVAL=2".' };
  }

  const parts = rule.trim().split(';').map(p => p.trim()).filter(Boolean);
  const seen = new Map();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      return { ok: false, error: `Malformed recurrence segment: "${part}". Use KEY=VALUE separated by ";".` };
    }
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate recurrence key: "${key}".` };
    }
    seen.set(key, value);
  }

  const allowed = ['FREQ', 'INTERVAL', 'UNTIL', 'BYDAY', 'EXDATE'];
  for (const key of seen.keys()) {
    if (!allowed.includes(key)) {
      return { ok: false, error: `Unsupported recurrence key: "${key}". Allowed: ${allowed.join(', ')}.` };
    }
  }

  const freq = (seen.get('FREQ') || '').toUpperCase();
  if (!freq) {
    return { ok: false, error: 'Recurrence rule needs FREQ. Use one of: ' + VALID_FREQS.join(', ') + '.' };
  }
  if (!VALID_FREQS.includes(freq)) {
    return { ok: false, error: `Invalid FREQ: "${freq}". Use one of: ${VALID_FREQS.join(', ')}.` };
  }

  let interval = 1;
  if (seen.has('INTERVAL')) {
    const raw = seen.get('INTERVAL');
    const parsedInterval = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsedInterval)
        || parsedInterval < 1
        || parsedInterval > constants.RECURRENCE_MAX_INTERVAL) {
      return {
        ok: false,
        error: `Invalid INTERVAL: "${raw}". Use a whole number from 1 to ${constants.RECURRENCE_MAX_INTERVAL}.`
      };
    }
    interval = parsedInterval;
  }

  let byday = [];
  if (seen.has('BYDAY')) {
    if (freq !== 'WEEKLY') {
      return { ok: false, error: 'BYDAY is only supported with FREQ=WEEKLY.' };
    }
    const codes = seen.get('BYDAY').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (codes.length === 0) {
      return { ok: false, error: 'BYDAY is empty. Use e.g. BYDAY=MO,WE,FR.' };
    }
    for (const code of codes) {
      if (!WEEKDAY_CODES.includes(code)) {
        return { ok: false, error: `Invalid BYDAY value: "${code}". Use ${WEEKDAY_CODES.join(', ')}.` };
      }
    }
    byday = [...new Set(codes)];
  }

  let exdate = [];
  if (seen.has('EXDATE')) {
    const dates = seen.get('EXDATE').split(',').map(d => d.trim()).filter(Boolean);
    if (dates.length === 0) {
      return { ok: false, error: 'EXDATE is empty. Use one or more YYYY-MM-DD values.' };
    }
    for (const d of dates) {
      // Noon always exists in Europe/Rome, so the same strict converter used
      // by reminders also rejects normalized dates such as 31 February here.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !convertRomeLocalToISO(`${d}T12:00:00`)) {
        return { ok: false, error: `Invalid EXDATE value: "${d}". Use YYYY-MM-DD.` };
      }
    }
    exdate = [...new Set(dates)];
  }

  return {
    ok: true,
    value: { freq, interval, byday, exdate, until: seen.get('UNTIL') || null }
  };
}

/**
 * The Europe/Rome calendar date (YYYY-MM-DD) of an instant.
 * @param {string|Date} iso
 * @returns {string|null}
 */
function romeDateString(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).split(' ')[0];
}

/**
 * Whether an occurrence falls on one of the recurrence's excluded dates.
 * @param {string|Date} iso - Occurrence instant.
 * @param {string[]} exdate - Excluded dates (YYYY-MM-DD, Europe/Rome).
 * @returns {boolean}
 */
function isDateSkipped(iso, exdate) {
  if (!Array.isArray(exdate) || exdate.length === 0) return false;
  const ds = romeDateString(iso);
  return ds ? exdate.includes(ds) : false;
}

/** Format an instant with its actual Europe/Rome wall clock and offset. */
function _toRomeISO(date) {
  return formatRomeInstantISO(date);
}

/** Build an ISO string with the right DST offset from Rome calendar fields. */
function _romeFieldsToISO(year, month, day, hour, minute, second) {
  const pad = (n) => String(n).padStart(2, '0');
  // Normalize any day overflow/underflow through a UTC calendar date.
  const normalized = new Date(Date.UTC(year, month - 1, day));
  const localISO = `${normalized.getUTCFullYear()}-${pad(normalized.getUTCMonth() + 1)}-${pad(normalized.getUTCDate())}`
    + `T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return convertRomeLocalToISO(localISO);
}

/** Normalize calendar arithmetic without assigning a timezone offset yet. */
function _normalizeCalendarFields(year, month, day, hour, minute, second) {
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
    day: normalized.getUTCDate(),
    hour: normalized.getUTCHours(),
    minute: normalized.getUTCMinutes(),
    second: normalized.getUTCSeconds(),
    weekday: normalized.getUTCDay()
  };
}

/**
 * Day offset for FREQ=WEEKLY;BYDAY=…: to the next selected weekday in the same
 * week, or to the first selected weekday INTERVAL weeks later (Monday-based
 * week start, matching the RFC default).
 * @param {number} weekday - Current Rome weekday (0 = Sunday).
 * @returns {number} Days to add.
 */
function _bydayOffset(weekday, interval, byday) {
  // Days from Monday (0 = Monday … 6 = Sunday) for week-boundary arithmetic.
  const asMondayIndex = (wd) => (wd + 6) % 7;
  const targets = byday.map(code => asMondayIndex(WEEKDAY_CODES.indexOf(code)));
  const currentIdx = asMondayIndex(weekday);

  const laterSameWeek = targets.filter(idx => idx > currentIdx).sort((a, b) => a - b);
  if (laterSameWeek.length > 0) return laterSameWeek[0] - currentIdx;

  // Wrap to the first selected weekday of the target week.
  return 7 * interval - currentIdx + Math.min(...targets);
}

/** Advance one calendar recurrence while retaining its local wall-clock fields. */
function _nextCalendarFields(current, rec, interval) {
  if (rec.freq === 'MONTHLY') {
    const targetMonthIndex = (current.month - 1) + interval;
    const targetYear = current.year + Math.floor(targetMonthIndex / 12);
    const targetMonth = (targetMonthIndex % 12) + 1;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const anchorDay = Number.isInteger(rec.anchorDay) && rec.anchorDay >= 1 && rec.anchorDay <= 31
      ? rec.anchorDay
      : current.day;
    return _normalizeCalendarFields(
      targetYear,
      targetMonth,
      Math.min(anchorDay, daysInTargetMonth),
      current.hour,
      current.minute,
      current.second
    );
  }

  let dayOffset;
  if (rec.freq === 'WEEKLY' && Array.isArray(rec.byday) && rec.byday.length > 0) {
    dayOffset = _bydayOffset(current.weekday, interval, rec.byday);
  } else if (rec.freq === 'WEEKLY') {
    dayOffset = interval * 7;
  } else {
    dayOffset = interval;
  }
  return _normalizeCalendarFields(
    current.year,
    current.month,
    current.day + dayOffset,
    current.hour,
    current.minute,
    current.second
  );
}

/**
 * Compute the single next occurrence after `scheduledAtISO`. Excluded dates are
 * NOT resolved here (that is advanceOccurrence's job).
 *
 * Calendar frequencies (DAILY/WEEKLY/MONTHLY) advance on the Europe/Rome
 * calendar, so a 09:00 reminder stays at 09:00 across DST switches. HOURLY
 * advances in real time, where an hour is always an hour.
 *
 * @param {string} scheduledAtISO - Current ISO date string with offset.
 * @param {object} rec - Normalized recurrence object.
 * @returns {string|null} Next occurrence ISO with correct offset, or null.
 */
function computeNextOccurrence(scheduledAtISO, rec) {
  if (!rec || !VALID_FREQS.includes(rec.freq)) return null;
  const baseDate = new Date(scheduledAtISO);
  if (isNaN(baseDate.getTime())) return null;

  const interval = Number.isInteger(rec.interval) && rec.interval >= 1 ? rec.interval : 1;

  if (rec.freq === 'HOURLY') {
    baseDate.setUTCHours(baseDate.getUTCHours() + interval);
    return _toRomeISO(baseDate);
  }

  let fields = getRomeParts(baseDate);
  // RFC-style local recurrence semantics: a wall-clock value in the spring
  // DST gap is omitted, not shifted and never treated as the end of the series.
  // The bound covers every daily candidate in the scheduler's one-year window.
  for (let i = 0; i < 370; i++) {
    fields = _nextCalendarFields(fields, rec, interval);
    const iso = _romeFieldsToISO(
      fields.year,
      fields.month,
      fields.day,
      fields.hour,
      fields.minute,
      fields.second
    );
    if (iso) return iso;
  }
  return null;
}

/**
 * Advance a recurring task to its next runnable occurrence, hopping over
 * excluded dates and stopping at UNTIL. Bounded to avoid infinite loops on
 * pathological EXDATE lists.
 * @param {string} scheduledAtISO - Current occurrence ISO.
 * @param {object} rec - Normalized recurrence object.
 * @returns {string|null} Next non-excluded occurrence ISO, or null when finished.
 */
function advanceOccurrence(scheduledAtISO, rec) {
  if (!rec) return null;
  const untilTime = rec.until ? new Date(rec.until).getTime() : null;
  let current = scheduledAtISO;
  // Covers every hourly candidate in the scheduler's one-year horizon,
  // including leap years, while bounding corrupt hand-edited task data.
  for (let i = 0; i < MAX_RECURRENCE_STEPS; i++) {
    const next = computeNextOccurrence(current, rec);
    if (!next) return null;
    const nextTime = new Date(next).getTime();
    if (Number.isFinite(untilTime) && nextTime > untilTime) return null;
    if (!isDateSkipped(next, rec.exdate)) return next;
    current = next;
  }
  return null;
}

/**
 * Advance a recurring task to its first occurrence strictly after `nowMs`.
 * Occurrences between the stored date and that instant are skipped in one
 * scheduler pass, so restarting after downtime cannot replay the backlog one
 * tick at a time.
 *
 * @param {string} scheduledAtISO - Stored occurrence ISO.
 * @param {object} rec - Normalized recurrence object.
 * @param {number} [nowMs=Date.now()]
 * @returns {{ next: string|null, skipped: number }}
 */
function advanceOccurrenceBeyond(scheduledAtISO, rec, nowMs = Date.now()) {
  const boundary = Number(nowMs);
  if (!Number.isFinite(boundary)) return { next: null, skipped: 0 };

  let current = scheduledAtISO;
  let skipped = 0;
  // The same bound covers every hourly occurrence in the one-year horizon.
  for (let i = 0; i < MAX_RECURRENCE_STEPS; i++) {
    const next = advanceOccurrence(current, rec);
    if (!next) return { next: null, skipped };
    if (new Date(next).getTime() > boundary) return { next, skipped };
    current = next;
    skipped++;
  }
  return { next: null, skipped };
}

/**
 * Coerce a recurrence read back from a task file into the canonical shape.
 * @param {object|null} rec
 * @param {string|null} [scheduledAtISO] - derives a missing monthly anchor for
 *   tasks persisted before anchorDay was introduced
 * @returns {{ freq: string, interval: number, byday: string[], exdate: string[], until: string|null, anchorDay?: number }|null}
 */
function normalizePersistedRecurrence(rec, scheduledAtISO = null) {
  if (!rec || typeof rec !== 'object') return null;
  const freq = String(rec.freq || '').toUpperCase();
  if (!VALID_FREQS.includes(freq)) return null;
  const normalized = {
    freq,
    interval: Number.isInteger(rec.interval) && rec.interval >= 1 ? rec.interval : 1,
    byday: Array.isArray(rec.byday) ? rec.byday : [],
    exdate: Array.isArray(rec.exdate) ? rec.exdate : [],
    until: rec.until || null
  };
  if (freq === 'MONTHLY') {
    let anchorDay = Number.isInteger(rec.anchorDay) && rec.anchorDay >= 1 && rec.anchorDay <= 31
      ? rec.anchorDay
      : null;
    if (!anchorDay && scheduledAtISO) {
      const start = new Date(scheduledAtISO);
      if (!isNaN(start.getTime())) anchorDay = getRomeParts(start).day;
    }
    if (anchorDay) normalized.anchorDay = anchorDay;
  }
  return normalized;
}

/**
 * Human-readable recurrence label (frequency + weekdays, no end date).
 * @param {object} rec - Normalized recurrence object.
 * @param {'en'|'it'} [lang='en']
 * @returns {string} e.g. "every 2 days" / "ogni 2 giorni" / "every Mon, Fri".
 */
function describeRecurrence(rec, lang = 'en') {
  if (!rec || !VALID_FREQS.includes(rec.freq)) return '';
  const prefix = lang === 'it' ? 'ogni' : 'every';
  const interval = Number.isInteger(rec.interval) && rec.interval >= 1 ? rec.interval : 1;

  if (rec.freq === 'WEEKLY' && Array.isArray(rec.byday) && rec.byday.length > 0) {
    const names = (WEEKDAY_NAMES[lang] || WEEKDAY_NAMES.en);
    const days = rec.byday
      .slice()
      .sort((a, b) => WEEKDAY_CODES.indexOf(a) - WEEKDAY_CODES.indexOf(b))
      .map(c => names[c])
      .join(', ');
    if (interval === 1) return `${prefix} ${days}`;
    const weekWord = (FREQ_WORDS[lang] || FREQ_WORDS.en).WEEKLY[1];
    return `${days} ${prefix} ${interval} ${weekWord}`;
  }

  const words = (FREQ_WORDS[lang] || FREQ_WORDS.en)[rec.freq];
  const word = interval === 1 ? words[0] : words[1];
  return interval === 1 ? `${prefix} ${word}` : `${prefix} ${interval} ${word}`;
}

export {
  _toRomeISO as toRomeISO,
  parseRecurrenceRule,
  normalizePersistedRecurrence,
  advanceOccurrence,
  advanceOccurrenceBeyond,
  isDateSkipped,
  describeRecurrence
};
