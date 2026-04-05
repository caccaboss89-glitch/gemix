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
 * Format a date to Italian datetime string (Europe/Rome timezone).
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted datetime 'DD/MM/YYYY HH:MM'
 */
function formatTimestamp(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = { getRomeTime, getRomeISO, formatTimestamp };
