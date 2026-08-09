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

const { convertRomeLocalToISO, getRomeParts } = require('./time');

const VALID_FREQS = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];

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
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
      return { ok: false, error: `Invalid INTERVAL: "${raw}". Use a whole number >= 1.` };
    }
    interval = parseInt(raw, 10);
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
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
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

/** Re-anchor a UTC instant to its Europe/Rome wall clock, as ISO with offset. */
function _toRomeISO(date) {
  const p = getRomeParts(date);
  return _romeFieldsToISO(p.year, p.month, p.day, p.hour, p.minute, p.second);
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

  const { year, month, day, hour, minute, second, weekday } = getRomeParts(baseDate);

  if (rec.freq === 'MONTHLY') {
    const targetMonthIndex = (month - 1) + interval;
    const targetYear = year + Math.floor(targetMonthIndex / 12);
    const targetMonth = (targetMonthIndex % 12) + 1;
    // Clamp to the last day when the target month is shorter (e.g. 31 -> 28).
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    return _romeFieldsToISO(targetYear, targetMonth, Math.min(day, daysInTargetMonth), hour, minute, second);
  }

  let dayOffset;
  if (rec.freq === 'WEEKLY' && Array.isArray(rec.byday) && rec.byday.length > 0) {
    dayOffset = _bydayOffset(weekday, interval, rec.byday);
  } else if (rec.freq === 'WEEKLY') {
    dayOffset = interval * 7;
  } else {
    dayOffset = interval; // DAILY
  }

  return _romeFieldsToISO(year, month, day + dayOffset, hour, minute, second);
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
  // Safety bound: far beyond any realistic 1-year recurrence.
  for (let i = 0; i < 1000; i++) {
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
 * Coerce a recurrence read back from a task file into the canonical shape.
 * @param {object|null} rec
 * @returns {{ freq: string, interval: number, byday: string[], exdate: string[], until: string|null }|null}
 */
function normalizePersistedRecurrence(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const freq = String(rec.freq || '').toUpperCase();
  if (!VALID_FREQS.includes(freq)) return null;
  return {
    freq,
    interval: Number.isInteger(rec.interval) && rec.interval >= 1 ? rec.interval : 1,
    byday: Array.isArray(rec.byday) ? rec.byday : [],
    exdate: Array.isArray(rec.exdate) ? rec.exdate : [],
    until: rec.until || null
  };
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

module.exports = {
  toRomeISO: _toRomeISO,
  parseRecurrenceRule,
  normalizePersistedRecurrence,
  advanceOccurrence,
  isDateSkipped,
  describeRecurrence
};
