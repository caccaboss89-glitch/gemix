function getRomeTime() {
  return new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
}

function getRomeISO() {
  const now = new Date();
  // Get the Rome time string in ISO-like format
  const romeTime = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).replace(' ', 'T');
  
  // Calculate Rome's offset correctly
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

function formatTimestamp(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

module.exports = { getRomeTime, getRomeISO, formatTimestamp };
