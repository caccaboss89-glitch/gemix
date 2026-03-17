const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { ACTIVE_MEMBERS } = require('../config/members');

const MONITOR_STATE_FILE = path.join(DATA_DIR, 'musicWrapMonitor.json');

const GITHUB_OWNER = 'SitoMusicBot';
const GITHUB_REPO = 'SitoMusicBot';
const GITHUB_BRANCH = 'main';
const MUSIC_WRAP_URL = 'https://sito-music-bot-git-main-albertos-projects-cf648a84.vercel.app/';

/**
 * Load monitor state from persistent file.
 * State tracks last processed commit hash and dates messages were sent to members.
 * @returns {object} Monitor state { lastCommitHash, lastSentDate }
 */
function loadMonitorState() {
  if (!fs.existsSync(MONITOR_STATE_FILE)) {
    return { lastCommitHash: null, lastSentDate: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(MONITOR_STATE_FILE, 'utf-8'));
  } catch {
    return { lastCommitHash: null, lastSentDate: {} };
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
  const italyDate = new Date(now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  italyDate.setMonth(italyDate.getMonth() - 1);
  return italyDate.toLocaleString('it-IT', { month: 'long' });
}

/**
 * Get the current date in Italy formatted as ISO string (YYYY-MM-DD only).
 * @returns {string} Date string format (e.g., '2026-03-17')
 */
function getItalyDateString() {
  const now = new Date();
  const italyDate = new Date(now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  return italyDate.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Check if today is the first day of the month in Italy timezone.
 * @returns {boolean} True if today is the 1st of the month
 */
function isFirstOfMonth() {
  const now = new Date();
  const italyDate = new Date(now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));
  return italyDate.getDate() === 1;
}

/**
 * Fetch the latest commit hash from GitHub
 * @returns {Promise<string|null>} Commit hash or null if error
 */
async function getLatestCommitHash() {
  try {
    const { fetchWithTimeout } = require('../utils/fetch');
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?sha=${GITHUB_BRANCH}&per_page=1`;
    
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'GemiX-MusicWrapMonitor/1.0'
    };

    const githubToken = process.env.GITHUB_TOKEN;
    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    const response = await fetchWithTimeout(url, { headers });
    
    if (!response.ok) {
      console.error(`[MusicWrap] ❌ Errore API GitHub: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.length === 0) {
      return null;
    }

    return data[0].sha;
  } catch (err) {
    console.error('[MusicWrap] ❌ Errore nel fetch dell\'hash commit:', err.message);
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
 * Triggers on: (1) First day of month (2) New commits detected (3) Not sent today.
 * @param {object} dedicatedClient - The whatsapp-web.js Client instance
 * @returns {Promise<void>}
 */
async function checkAndSendMusicWrap(dedicatedClient) {
  if (!dedicatedClient) {
    console.log('[MusicWrap] ⚠️  Dedicated WhatsApp client not available');
    return;
  }

  if (!isFirstOfMonth()) {
    return;
  }

  console.log('[MusicWrap] ✅ Oggi è il primo! Verifica in corso...');

  const latestCommitHash = await getLatestCommitHash();
  if (!latestCommitHash) {
    console.log('[MusicWrap] ⚠️  Impossibile verificare il commit da GitHub');
    return;
  }

  const state = loadMonitorState();

  if (state.lastCommitHash === latestCommitHash) {
    console.log('[MusicWrap] ℹ️  Nessun nuovo aggiornamento rilevato');
    return;
  }

  console.log(`[MusicWrap] ✅ Nuovo aggiornamento rilevato (commit: ${latestCommitHash.slice(0, 7)})`);

  const today = getItalyDateString();
  let sentCount = 0;

  for (const member of ACTIVE_MEMBERS) {
    if (wasMessageSentToday(member.wa, state)) {
      console.log(`[MusicWrap] ℹ️  Messaggio già inviato a ${member.name} oggi`);
      continue;
    }

    try {
      const message = `🎵 *Wrap di ${getPreviousMonthName().charAt(0).toUpperCase() + getPreviousMonthName().slice(1)} aggiornato!* 🎵\n\nÈ disponibile il tuo wrap musicale aggiornato del mese precedente:\n\n🔗 ${MUSIC_WRAP_URL}\nPassword: "caccaboss". \n\nGoditi le tue statistiche! 🎧📊`;
      await dedicatedClient.sendMessage(member.wa, message);
      console.log(`[MusicWrap] ✅ Messaggio inviato a ${member.name}`);
      state.lastSentDate[member.wa] = today;
      sentCount++;
    } catch (err) {
      console.error(`[MusicWrap] ❌ Errore per ${member.name}:`, err.message);
    }
  }

  state.lastCommitHash = latestCommitHash;
  saveMonitorState(state);

  if (sentCount > 0) {
    console.log(`[MusicWrap] ✅ Completato: ${sentCount} messaggi inviati`);
  }
}

module.exports = { checkAndSendMusicWrap };
