const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { GITHUB_TOKEN, GITHUB_REPO } = require('../config/env');
const { getSubscribedChats } = require('../tools/releaseNotify');
const { fetchWithTimeout } = require('../utils/fetch');
const { createLogger } = require('../utils/logger');

const log = createLogger('ReleaseMonitor');

const STATE_FILE = path.join(DATA_DIR, 'releaseMonitor.json');
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let lastCheckedReleaseId = null;
let lastCheckTime = 0;

function _loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (raw.lastReleaseId) lastCheckedReleaseId = raw.lastReleaseId;
  } catch {}
}

function _saveState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastReleaseId: lastCheckedReleaseId }, null, 2), 'utf-8');
}

_loadState();

/**
 * Check GitHub for new releases and notify subscribed chats.
 * Called periodically by the scheduler engine.
 * @param {object} waClient - whatsapp-web.js Client instance
 */
async function checkNewRelease(waClient) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (!waClient) return;

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
  lastCheckTime = now;

  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'GemiX-Bot',
        },
      },
      15_000,
    );

    if (!res.ok) {
      if (res.status !== 404) log.error(`GitHub API errore: ${res.status}`);
      return;
    }

    const release = await res.json();
    if (!release || !release.id) return;

    const releaseId = String(release.id);

    // First run: just store the current release, don't notify
    if (lastCheckedReleaseId === null) {
      lastCheckedReleaseId = releaseId;
      _saveState();
      log.info(`📌 Release iniziale registrata: ${release.tag_name}`);
      return;
    }

    if (releaseId === lastCheckedReleaseId) return;

    // New release detected
    lastCheckedReleaseId = releaseId;
    _saveState();

    const title = release.name || release.tag_name || 'Nuova release';
    const body = release.body || '';

    const message = `🚀 *Nuova release GemiX: ${title}*\n\n${body}`.trim();

    const subscribedChats = getSubscribedChats();
    if (subscribedChats.size === 0) {
      log.info(`📦 Nuova release ${title} rilevata, ma nessuna chat sottoscritta.`);
      return;
    }

    log.info(`📦 Nuova release ${title} — invio a ${subscribedChats.size} chat(s)...`);

    for (const [chatId, waJid] of subscribedChats) {
      try {
        await waClient.sendMessage(waJid, message);
      } catch (err) {
        log.error(`Errore invio release a ${waJid} (chat ${chatId}):`, err.message);
      }
    }
  } catch (err) {
    log.error('Errore controllo release:', err.message);
  }
}

module.exports = { checkNewRelease };
