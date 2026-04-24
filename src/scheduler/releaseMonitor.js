// src/scheduler/releaseMonitor.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { GITHUB_TOKEN, GITHUB_REPO } = require('../config/env');
const { getSubscribedChats } = require('../tools/releaseNotify');
const { fetchWithTimeout } = require('../utils/fetch');
const { createLogger } = require('../utils/logger');
const { MessageMedia } = require('whatsapp-web.js');

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
  } catch { }
}

function _saveState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastReleaseId: lastCheckedReleaseId }, null, 2), 'utf-8');
}

_loadState();

/**
 * Extract image URLs from a markdown string (![alt](url) syntax).
 * @param {string} markdown
 * @returns {string[]}
 */
function _extractMarkdownImageUrls(markdown) {
  const regex = /!\[.*?\]\((https?:\/\/[^)\s]+)\)/g;
  const urls = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * Download an image from a URL and return a MessageMedia object, or null on failure.
 * @param {string} url
 * @param {string|null} name
 * @param {object} headers - Auth headers for GitHub
 * @returns {Promise<import('whatsapp-web.js').MessageMedia|null>}
 */
async function _fetchImageMedia(url, name, headers) {
  try {
    const res = await fetchWithTimeout(url, { headers }, 15_000);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
    if (!mimetype.startsWith('image/')) return null;
    const filename = name || url.split('/').pop().split('?')[0] || 'image.jpg';
    return new MessageMedia(mimetype, buffer.toString('base64'), filename);
  } catch {
    return null;
  }
}

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
    const authHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'GemiX-Bot',
    };

    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: authHeaders },
      15_000,
    );

    if (!res.ok) {
      if (res.status !== 404) log.error(`Errore API GitHub: ${res.status}`);
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

    // Strip markdown image syntax (images are sent separately as media)
    const cleanBody = body.replace(/!\[.*?\]\(https?:\/\/[^)\s]+\)/g, '').replace(/\n{3,}/g, '\n\n').trim();

    const message = `🚀 *Nuova release GemiX: ${title}*\n\n${cleanBody}`.trim();

    // Collect images: inline markdown images + image assets
    const inlineImageUrls = _extractMarkdownImageUrls(body);
    const assetImages = (release.assets || [])
      .filter(a => a.content_type && a.content_type.startsWith('image/'))
      .map(a => ({ url: a.browser_download_url, name: a.name }));

    const allImageSources = [
      ...inlineImageUrls.map(url => ({ url, name: null })),
      ...assetImages,
    ];

    // Pre-download images once for all subscribers
    const mediaItems = [];
    for (const img of allImageSources) {
      const media = await _fetchImageMedia(img.url, img.name, authHeaders);
      if (media) mediaItems.push(media);
    }

    if (mediaItems.length > 0) {
      log.info(`🖼️ ${mediaItems.length} immagine/i trovate per la release ${title}`);
    }

    const subscribedChats = getSubscribedChats();
    if (subscribedChats.size === 0) {
      log.info(`📦 Nuova release ${title} rilevata, ma nessuna chat sottoscritta.`);
      return;
    }

    log.info(`📦 Nuova release ${title} — invio a ${subscribedChats.size} chat(s)...`);

    for (const [chatId, waJid] of subscribedChats) {
      try {
        await waClient.sendMessage(waJid, message);
        for (const media of mediaItems) {
          try {
            await waClient.sendMessage(waJid, media);
          } catch (imgErr) {
            log.warn(`Errore invio immagine release a ${waJid}: ${imgErr.message}`);
          }
        }
      } catch (err) {
        log.error(`Errore invio release a ${waJid} (chat ${chatId}):`, err.message);
      }
    }
  } catch (err) {
    log.error('Errore controllo release:', err.message);
  }
}

module.exports = { checkNewRelease };
