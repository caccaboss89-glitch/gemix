// src/scheduler/musicWrapMonitor.js
//
// Monitors GitHub music stats for updates and sends monthly wrap notifications
// to active members on the 1st of each month (or when new stats appear).
// Persists state via systemState.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { ACTIVE_MEMBERS } = require('../config/members');
const { createLogger } = require('../utils/logger');
const { normalizeMarkdown } = require('../utils/text');

const log = createLogger('MusicWrap');

const { MUSIC_WRAP_PASSWORD, MUSIC_STATS_URL, MUSIC_WRAP_URL } = require('../config/env');

const { get: getSystemState, update: updateSystemState } = require('../utils/systemState');
const { fetchExternal } = require('../utils/fetch');
const { MUSIC_WRAP_PREFIX } = require('../config/systemMessages');

/**
 * Load monitor state from unified system state.
 * State tracks last stats timestamp, dates messages were sent to members, and last check date.
 * @returns {object} Monitor state { lastStatsTimestamp, lastSentDate, lastCheckDate }
 */
function loadMonitorState() {
  const state = getSystemState('musicWrap');
  if (state) return state;


  const OLD_FILE = path.join(DATA_DIR, 'musicWrapMonitor.json');
  if (fs.existsSync(OLD_FILE)) {
    try {
      const oldState = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8'));

      return oldState;
    } catch { }
  }
  
  return { lastStatsTimestamp: null, lastSentDate: {}, lastCheckDate: null };
}

/**
 * Save monitor state to unified system state.
 * @param {object} state - Monitor state object to save
 * @returns {Promise<void>}
 */
async function saveMonitorState(state) {
  await updateSystemState('musicWrap', state);
}

/**
 * Get the previous/last month name in Italian locale.
 * @returns {string} Month name (e.g., 'gennaio', 'febbraio')
 */
function getPreviousMonthName() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: 'numeric',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(p => [p.type, p.value])
  );
  const prevMonth = new Date(parseInt(parts.year, 10), parseInt(parts.month, 10) - 2, 15);
  return prevMonth.toLocaleString('it-IT', { month: 'long' });
}

/**
 * Get the current date in Italy formatted as ISO string (YYYY-MM-DD only).
 * @returns {string} Date string format (e.g., '2026-03-17')
 */
function getItalyDateString() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Check if today is the first day of the month in Italy timezone.
 * @returns {boolean} True if today is the 1st of the month
 */
function isFirstOfMonth() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    day: 'numeric',
  });
  const day = parseInt(formatter.format(now), 10);
  log.info(`isFirstOfMonth check: day=${day} (${now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })})`);
  return day === 1;
}

/**
 * Fetch and check if stats.json was updated on GitHub via raw URL.
 * @returns {Promise<string|null>} Content hash or null if error/no change
 */
async function checkStatsFileUpdate() {
  try {
    const response = await fetchExternal(MUSIC_STATS_URL, {
      headers: { 'User-Agent': 'GemiX-MusicWrapMonitor/1.0' },
    }, 'Music Stats Check');

    if (!response.ok) {
      log.error(`Failed to read stats.json: ${response.status}`);
      return null;
    }

    const data = await response.json();
    // Use the lastUpdated timestamp from the file as the change identifier
    const timestamp = data.lastUpdated || new Date().toISOString();
    return timestamp;
  } catch (err) {
    log.error('Failed to fetch stats.json:', err.message);
    return null;
  }
}

/**
 * Check if message was already sent to a member today.
 * @param {string} memberWa - WhatsApp JID of the member
 * @param {object} state - Current monitor state
 * @returns {boolean} True if message was sent to this member today
 */
function wasMessageSentToday(memberWa, state) {
  const today = getItalyDateString();
  return state.lastSentDate[memberWa] === today;
}

/**
 * Check conditions and send music wrap notification message to active members.
 * Triggers on: (1) First day of month (2) New commits detected (3) Not checked today.
 * @param {object} dedicatedClient - The whatsapp-web.js Client instance
 * @returns {Promise<void>}
 */
async function checkAndSendMusicWrap(dedicatedClient) {
  if (!dedicatedClient) {
    log.warn('Dedicated WhatsApp client unavailable (not ready yet)');
    return;
  }

  if (!isFirstOfMonth()) {
    // Silently skip - isFirstOfMonth already logs the day check
    return;
  }

  const today = getItalyDateString();
  const state = loadMonitorState();

  // If the check was already done today (per systemState lastCheckDate), skip.
  if (state.lastCheckDate === today) {
    log.info(`Already checked today (${today}), skipping`);
    return;
  }

  log.info('First of month! Running checks...');

  const statsTimestamp = await checkStatsFileUpdate();
  if (!statsTimestamp) {
    log.warn('Unable to verify updates from GitHub');
    return;
  }

  if (state.lastStatsTimestamp === statsTimestamp) {
    log.info('No new update detected (timestamp: ' + statsTimestamp + ')');
    // Record the check even without updates.
    state.lastCheckDate = today;
    await saveMonitorState(state);
    return;
  }

  log.info(`New update detected (timestamp: ${statsTimestamp})`);

  let sentCount = 0;

  for (const member of ACTIVE_MEMBERS) {
    if (wasMessageSentToday(member.wa, state)) {
      log.info(`Message already sent to ${member.name} today`);
      continue;
    }

    try {
      const monthName = getPreviousMonthName();
      const capitalizedMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
      const password = MUSIC_WRAP_PASSWORD || 'N/D';
      const message = normalizeMarkdown(`${MUSIC_WRAP_PREFIX} ${capitalizedMonth} aggiornato!* 🎵\n\nÈ disponibile il tuo wrap musicale aggiornato del mese precedente:\n\n🔗 ${MUSIC_WRAP_URL}\nPassword: "${password}". \n\nGoditi le tue statistiche! 🎧📊`);
      await dedicatedClient.sendMessage(member.wa, message);
      log.info(`Message sent to ${member.name}`);
      state.lastSentDate[member.wa] = today;
      sentCount++;
    } catch (err) {
      log.error(`Error sending to ${member.name}:`, err.message);
    }
  }

  state.lastStatsTimestamp = statsTimestamp;
  state.lastCheckDate = today;
  await saveMonitorState(state);

  if (sentCount > 0) {
    log.info(`Done: ${sentCount}/${ACTIVE_MEMBERS.length} messages sent`);
  }
}

module.exports = { checkAndSendMusicWrap };
