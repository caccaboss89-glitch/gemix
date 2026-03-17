/**
 * Get current time in Rome (Europe/Rome timezone) as localized string.
 * @returns {string} Formatted time string (it-IT locale)
 */
function getRomeTime() {
  return new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
}

/**
 * Get current time in Rome as ISO 8601 format with timezone offset.
 * @returns {string} ISO format datetime with +HH:MM offset (Europe/Rome)
 */
function getRomeISO() {
  const now = new Date();
  const romeTime = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).replace(' ', 'T');
  
  const utcTime = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const romeDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const offsetMs = romeDate.getTime() - utcTime.getTime();
  const offsetMins = offsetMs / 60000;
  
  const sign = offsetMins < 0 ? '-' : '+';
  const absOffsetMins = Math.abs(offsetMins);
  const hours = String(Math.floor(absOffsetMins / 60)).padStart(2, '0');
  const mins = String(Math.floor(absOffsetMins % 60)).padStart(2, '0');
  
  return romeTime + sign + hours + ':' + mins;
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
