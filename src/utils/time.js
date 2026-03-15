function getRomeTime() {
  return new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
}

function getRomeISO() {
  const now = new Date();
  const rome = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const offset = rome.getTimezoneOffset();
  const sign = offset <= 0 ? '+' : '-';
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const m = String(Math.abs(offset) % 60).padStart(2, '0');
  return now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).replace(' ', 'T') + sign + h + ':' + m;
}

function formatTimestamp(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = { getRomeTime, getRomeISO, formatTimestamp };
