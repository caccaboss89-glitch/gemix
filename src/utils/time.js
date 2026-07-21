// src/utils/time.js
//
// Time utilities with strong focus on Europe/Rome timezone and DST handling.
// Provides reliable ISO conversion, DST transition detection, and formatting
// helpers used by the scheduler and other time-sensitive components.

 /**
 * Get current time in Rome (Europe/Rome timezone) as localized string.
 * @returns {string} Formatted time string (it-IT locale)
 */
function getRomeTime() {
  return new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
}

/**
 * Get current time in Rome as ISO 8601 format with timezone offset.
 * Uses Intl.DateTimeFormat.formatToParts for reliable DST-aware offset calculation.
 * @returns {string} ISO format datetime with +HH:MM offset (Europe/Rome)
 */
function getRomeISO() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(p => [p.type, p.value])
  );
  // Some runtimes return '24' for midnight in hour12:false mode
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const romeLocalStr = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;

  // Compute UTC offset: treat Rome local time as UTC and diff against actual UTC
  const romeAsUTC = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10),
  );
  const offsetMins = Math.round((romeAsUTC - now.getTime()) / 60000);

  const sign = offsetMins >= 0 ? '+' : '-';
  const absOffsetMins = Math.abs(offsetMins);
  const hh = String(Math.floor(absOffsetMins / 60)).padStart(2, '0');
  const mm = String(absOffsetMins % 60).padStart(2, '0');

  return `${romeLocalStr}${sign}${hh}:${mm}`;
}

/**
 * Get the current Europe/Rome wall-clock as structured parts (DST-aware).
 * Same timezone basis as reminders and sent-message timestamps (never UTC).
 * The weekday is derived from the Rome calendar date, so it stays correct
 * regardless of the machine timezone or DST.
 * @param {Date} [date] - Instant to convert (defaults to now).
 * @returns {{ year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number }}
 *   weekday: 0 = Sunday … 6 = Saturday.
 */
function getRomeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(p => [p.type, p.value])
  );
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  // Some runtimes return '24' for midnight in hour12:false mode.
  const hour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10);
  // Weekday of the Rome calendar date (midnight UTC of that date is unambiguous).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return {
    year,
    month,
    day,
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekday,
  };
}

/**
 * Get the last Sunday of a given month and year.
 * Used for calculating DST transition dates (last Sunday of March and October).
 * @param {number} year - Year (e.g., 2026)
 * @param {number} month - Month (1-12, e.g., 3 for March, 10 for October)
 * @returns {number} Day of month (1-31) of the last Sunday
 */
function getLastSundayOfMonth(year, month) {
  // Start with the last day of the month
  const lastDay = new Date(year, month, 0).getDate();
  
  // Find the last Sunday by checking backwards from the last day
  for (let day = lastDay; day >= 1; day--) {
    const date = new Date(year, month - 1, day);
    if (date.getDay() === 0) { // 0 = Sunday
      return day;
    }
  }
  
  // This should never happen - every month has at least one Sunday
  throw new Error(`getLastSundayOfMonth: No Sunday found in month ${month}/${year}. Data integrity issue.`);
}

/**
 * Detect if a datetime falls during an ambiguous or non-existent hour during DST transitions.
 * Returns a warning message if applicable.
 * 
 * EU DST transitions happen on the last Sunday of March and October:
 * - Spring: Last Sunday of March at 02:00 - 03:00 (02:00-02:59:59 doesn't exist)
 * - Fall: Last Sunday of October at 03:00 - 02:00 (02:00-02:59:59 exists twice)
 * 
 * @param {string} localDatetime - ISO datetime without offset (Roma local): "2026-03-29T02:30:00"
 * @returns {string|null} Warning message if hour is ambiguous, null otherwise
 */
function checkDSTAmbiguousHour(localDatetime) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(localDatetime);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);

  // Spring forward: last Sunday of March at 02:00 - 03:00 (02:00-02:59:59 doesn't exist)
  const lastSundayMarch = getLastSundayOfMonth(year, 3);
  if (month === 3 && day === lastSundayMarch && hour === 2) {
    return `Invalid time: on March ${day}, ${year} at 02:00 the clock jumps directly to 03:00 (start of daylight saving time). Choose 01:30 or 03:30 instead.`;
  }

  // Fall back: last Sunday of October at 02:00-02:59 (exists twice - ambiguous)
  const lastSundayOctober = getLastSundayOfMonth(year, 10);
  if (month === 10 && day === lastSundayOctober && hour === 2) {
    return `Ambiguous time: on October ${day}, ${year} at 02:00-02:59 the hour occurs twice (end of daylight saving time). The task will be scheduled for the second occurrence (standard time +01:00).`;
  }

  return null;
}

/**
 * Format a date to Italian datetime string (Europe/Rome timezone).
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted datetime 'DD/MM/YYYY HH:MM'
 */
function formatTimestamp(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Convert a Rome local datetime (without offset) to ISO 8601 with correct DST-aware offset.
 * This ensures that regardless of DST status, the offset is calculated correctly for that specific date.
 * Handles DST transitions correctly by finding the UTC time that maps to the desired Rome local time.
 * 
 * @param {string} localDatetime - ISO datetime WITHOUT offset (Rome local): "2026-04-17T16:30:00"
 * @returns {string|null} ISO 8601 with offset (e.g., "2026-04-17T16:30:00+02:00") or null if invalid
 * 
 * @example
 * convertRomeLocalToISO("2026-04-17T16:30:00") // -> "2026-04-17T16:30:00+02:00" (DST)
 * convertRomeLocalToISO("2026-01-15T16:30:00") // -> "2026-01-15T16:30:00+01:00" (Standard time)
 */
function convertRomeLocalToISO(localDatetime) {
  // Validate format (must be YYYY-MM-DDTHH:MM:SS or YYYY-MM-DDTHH:MM:SS.mmm)
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/;
  if (!iso8601Regex.test(localDatetime)) {
    return null;
  }

  const [datePart, timePart] = localDatetime.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split(':').map(Number);

  // Validate ranges
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  // To find the correct UTC time that corresponds to this Rome local time,
  // we try both possible offsets (+01:00 standard, +02:00 DST).
  // The Intl API will tell us what Rome local time each UTC time produces.

  // Helper function to check what Rome local time a UTC date converts to
  function getRomeLocalTime(utcDate) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(utcDate).map(p => [p.type, p.value])
    );
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: parts.hour === '24' ? 0 : parseInt(parts.hour, 10),
      minute: parseInt(parts.minute, 10),
      second: parseInt(parts.second, 10),
    };
  }

  // Try both possible offsets (60 and 120 minutes = +01:00 and +02:00)
  let bestUtcDate = null;
  let bestMatch = null;

  for (let offsetMins of [60, 120]) {
    const testUtcDate = new Date(Date.UTC(year, month - 1, day, hour - Math.floor(offsetMins / 60), minute, second, 0));
    const testRomeTime = getRomeLocalTime(testUtcDate);

    if (testRomeTime.year === year && testRomeTime.month === month && testRomeTime.day === day &&
        testRomeTime.hour === hour && testRomeTime.minute === minute && testRomeTime.second === second) {
      bestUtcDate = testUtcDate;
      bestMatch = offsetMins;
      break;
    }
  }

  if (bestUtcDate === null) {
    // Fallback: no exact match found (e.g., non-existent spring-forward hour). Use +02:00 (CEST, active after transition).
    bestUtcDate = new Date(Date.UTC(year, month - 1, day, hour - 2, minute, second, 0));
    bestMatch = 120;
  }

  const offsetMins = bestMatch;
  const sign = offsetMins >= 0 ? '+' : '-';
  const absOffsetMins = Math.abs(offsetMins);
  const hh = String(Math.floor(absOffsetMins / 60)).padStart(2, '0');
  const mm = String(absOffsetMins % 60).padStart(2, '0');

  return `${localDatetime}${sign}${hh}:${mm}`;
}

module.exports = { getRomeTime, getRomeISO, getRomeParts, formatTimestamp, convertRomeLocalToISO, checkDSTAmbiguousHour };
