// src/scheduler/musicWrapMonitor.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { ACTIVE_MEMBERS } = require('../config/members');
const { createLogger } = require('../utils/logger');
const { normalizeMarkdown } = require('../utils/text');

const log = createLogger('MusicWrap');

const { MUSIC_WRAP_PASSWORD } = require('../config/env');

const MONITOR_STATE_FILE = path.join(DATA_DIR, 'musicWrapMonitor.json');

const MUSIC_WRAP_URL = 'https://sito-music-bot.vercel.app/';

/**
 * Load monitor state from persistent file.
 * State tracks last stats timestamp, dates messages were sent to members, and last check date.
 * @returns {object} Monitor state { lastStatsTimestamp, lastSentDate, lastCheckDate }
 */
function loadMonitorState() {
  if (!fs.existsSync(MONITOR_STATE_FILE)) {
    return { lastStatsTimestamp: null, lastSentDate: {}, lastCheckDate: null };
  }
  try {
    return JSON.parse(fs.readFileSync(MONITOR_STATE_FILE, 'utf-8'));
  } catch {
    return { lastStatsTimestamp: null, lastSentDate: {}, lastCheckDate: null };
  }
}

/**
 * Save monitor state to persistent file.
 * @param {object} state - Monitor state object to save
 * @returns {void}
 */
function saveMonitorState(state) {
  fs.writeFileSync(MONITOR_STATE_FILE, JSON.stringify(state, null, 2));
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
  log.info(`🔍 isFirstOfMonth check: day=${day} (${now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })})`);
  return day === 1;
}

/**
 * Fetch and check if stats.json was updated on GitHub
 * Uses raw GitHub URL (same as musicStats tool) instead of API commits endpoint
 * @returns {Promise<string|null>} Content hash or null if error/no change
 */
async function checkStatsFileUpdate() {
  try {
    const { fetchExternal } = require('../utils/fetch');
    const STATS_URL = 'https://raw.githubusercontent.com/caccaboss89-glitch/MusicBot/main/data/stats.json';

    const response = await fetchExternal(STATS_URL, {
      headers: { 'User-Agent': 'GemiX-MusicWrapMonitor/1.0' },
    }, 'Music Stats Check');

    if (!response.ok) {
      log.error(`❌ Errore lettura stats.json: ${response.status}`);
      return null;
    }

    const data = await response.json();
    // Usa il timestamp lastUpdated dal file come identificatore di cambio
    const timestamp = data.lastUpdated || new Date().toISOString();
    return timestamp;
  } catch (err) {
    log.error('❌ Errore fetch stats.json:', err.message);
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
    log.warn('⚠️  Client WhatsApp dedicato non disponibile (non ancora ready)');
    return;
  }

  if (!isFirstOfMonth()) {
    // Silently skip - isFirstOfMonth already logs the day check
    return;
  }

  const today = getItalyDateString();
  const state = loadMonitorState();

  // Se il check è già stato fatto oggi, salta (anche se il bot è riavviato)
  if (state.lastCheckDate === today) {
    log.info(`ℹ️  Check già eseguito oggi (${today}), skip`);
    return;
  }

  log.info('✅ Oggi è il primo! Verifica in corso...');

  const statsTimestamp = await checkStatsFileUpdate();
  if (!statsTimestamp) {
    log.warn('⚠️  Impossibile verificare gli aggiornamenti da GitHub');
    return;
  }

  if (state.lastStatsTimestamp === statsTimestamp) {
    log.info('ℹ️  Nessun nuovo aggiornamento rilevato (timestamp: ' + statsTimestamp + ')');
    // Registra il check pur senza aggiornamenti, così non ricontrolla oggi al reboot
    state.lastCheckDate = today;
    saveMonitorState(state);
    return;
  }

  log.info(`✅ Nuovo aggiornamento rilevato (timestamp: ${statsTimestamp})`);

  let sentCount = 0;

  for (const member of ACTIVE_MEMBERS) {
    if (wasMessageSentToday(member.wa, state)) {
      log.info(`ℹ️  Messaggio già inviato a ${member.name} oggi`);
      continue;
    }

    try {
      const monthName = getPreviousMonthName();
      const capitalizedMonth = monthName.charAt(0).toUpperCase() + monthName.slice(1);
      const password = MUSIC_WRAP_PASSWORD || 'N/D';
      const message = normalizeMarkdown(`🎵 *Wrap di ${capitalizedMonth} aggiornato!* 🎵\n\nÈ disponibile il tuo wrap musicale aggiornato del mese precedente:\n\n🔗 ${MUSIC_WRAP_URL}\nPassword: "${password}". \n\nGoditi le tue statistiche! 🎧📊`);
      await dedicatedClient.sendMessage(member.wa, message);
      log.info(`✅ Messaggio inviato a ${member.name}`);
      state.lastSentDate[member.wa] = today;
      sentCount++;
    } catch (err) {
      log.error(`❌ Errore per ${member.name}:`, err.message);
    }
  }

  state.lastStatsTimestamp = statsTimestamp;
  state.lastCheckDate = today;
  saveMonitorState(state);

  if (sentCount > 0) {
    log.info(`✅ Completato: ${sentCount} messaggi inviati su ${ACTIVE_MEMBERS.length} membri`);
  }
}

module.exports = { checkAndSendMusicWrap };
