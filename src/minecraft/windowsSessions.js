// src/minecraft/windowsSessions.js
//
// Whether someone is using the PC, read from its logon sessions.
//
// The PC may log its account in automatically at boot, so a session alone
// proves nothing: someone is at the PC when a connected session has seen input
// since it logged in. `quser` reports each session's idle time and the start of
// its explorer.exe marks the logon; a session idle for about as long as it has
// existed has never been touched.

/** quser reports idle time in whole minutes; this absorbs that and the logon-to-explorer gap. */
const LOGON_SLACK_MS = 2 * 60 * 1000;

/**
 * Idle time of a quser IDLE TIME field: minutes, "H:MM" or "D+HH:MM". The
 * localized word for "none" and the "." of a session in use are zero.
 * @returns {number} milliseconds
 */
function parseIdleMs(field) {
  let match = /^(\d+)\+(\d+):(\d+)$/.exec(field);
  if (match) return ((Number(match[1]) * 24 + Number(match[2])) * 60 + Number(match[3])) * 60_000;
  match = /^(\d+):(\d+)$/.exec(field);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 60_000;
  return /^\d+$/.test(field) ? Number(field) * 60_000 : 0;
}

/**
 * The sessions in quser's output. A disconnected session has no session name,
 * and nobody can be using it.
 * @returns {Array<{ id: number, connected: boolean, idleMs: number }>}
 */
function parseQuserSessions(text) {
  const sessions = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const match = /^.(\S+)\s+(?:(\S+)\s+)?(\d+)\s+(\S+)\s+(\S+)\s+\S/.exec(line);
    if (!match) continue;
    sessions.push({ id: Number(match[3]), connected: Boolean(match[2]), idleMs: parseIdleMs(match[5]) });
  }
  return sessions;
}

/**
 * Whether a connected session has seen input since its logon. A session whose
 * explorer has not started yet counts as in use, so doubt never lets the PC be
 * turned off under someone.
 *
 * @param {{ quser: string, explorers: Array<{ session: number, started: string }>, now?: number }} probe
 * @returns {boolean}
 */
function isUserPresent({ quser, explorers, now = Date.now() }) {
  return parseQuserSessions(quser).some((session) => {
    if (!session.connected) return false;
    const starts = explorers
      .filter(explorer => explorer.session === session.id)
      .map(explorer => Date.parse(explorer.started))
      .filter(Number.isFinite);
    if (starts.length === 0) return true;
    return session.idleMs < now - Math.min(...starts) - LOGON_SLACK_MS;
  });
}

export { isUserPresent, parseIdleMs, parseQuserSessions };
