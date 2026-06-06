// src/scheduler/releaseMonitor.js
//
// Monitors GitHub releases and notifies subscribed chats (via releaseNotify)
// with release notes; inline HTML/markdown images and audio links are stripped
// from the text and sent as separate WhatsApp media messages.
// Persists last seen release ID via systemState.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { GITHUB_TOKEN, GITHUB_REPO } = require('../config/env');
const { getSubscribedChats } = require('../tools/releaseNotify');
const { fetchWithTimeout } = require('../utils/fetch');
const { createLogger } = require('../utils/logger');
const { MessageMedia } = require('whatsapp-web.js');

const log = createLogger('ReleaseMonitor');

const { get: getSystemState, update: updateSystemState } = require('../utils/systemState');
const { RELEASE_NOTIFICATION_PREFIX } = require('../config/systemMessages');

let lastCheckedReleaseId = null;

function _loadState() {
  const state = getSystemState('releases');
  if (state && state.lastReleaseId) {
    lastCheckedReleaseId = state.lastReleaseId;
    return;
  }


  const OLD_FILE = path.join(DATA_DIR, 'releaseMonitor.json');
  if (fs.existsSync(OLD_FILE)) {
    try {
      const oldState = JSON.parse(fs.readFileSync(OLD_FILE, 'utf-8'));
      if (oldState.lastReleaseId) {
        lastCheckedReleaseId = oldState.lastReleaseId;
      }
    } catch { }
  }
}

async function _saveState() {
  await updateSystemState('releases', { lastReleaseId: lastCheckedReleaseId });
}

_loadState();

const AUDIO_FILE_EXT = '(?:mp3|wav|ogg|m4a|aac|flac|opus|webm|oga)';
const HTML_IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi;
const MARKDOWN_IMG_RE = /!\[.*?\]\((https?:\/\/[^)\s]+)\)/g;
const MARKDOWN_AUDIO_RE = new RegExp(
  `\\[([^\\]]+\\.${AUDIO_FILE_EXT})\\]\\((https?:\\/\\/[^)\\s]+)\\)`,
  'gi',
);

const EXT_AUDIO_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

/**
 * Extract image URLs from markdown (![alt](url)).
 * @param {string} markdown
 * @returns {string[]}
 */
function _extractMarkdownImageUrls(markdown) {
  const urls = [];
  let match;
  while ((match = MARKDOWN_IMG_RE.exec(markdown)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * Extract image URLs from GitHub HTML <img src="..."> tags.
 * @param {string} markdown
 * @returns {{ url: string, name: string|null }[]}
 */
function _extractHtmlImageSources(markdown) {
  const items = [];
  let match;
  while ((match = HTML_IMG_SRC_RE.exec(markdown)) !== null) {
    const fullTag = match[0];
    const altMatch = /\balt=["']([^"']*)["']/i.exec(fullTag);
    items.push({ url: match[1], name: altMatch?.[1]?.trim() || null });
  }
  return items;
}

/**
 * Extract audio file links from markdown ([file.mp3](url)).
 * @param {string} markdown
 * @returns {{ url: string, name: string }[]}
 */
function _extractMarkdownAudioLinks(markdown) {
  const items = [];
  let match;
  while ((match = MARKDOWN_AUDIO_RE.exec(markdown)) !== null) {
    items.push({ url: match[2], name: match[1].trim() });
  }
  return items;
}

/**
 * Parse release body: strip embedded media markup and collect image/audio sources.
 * @param {string} body
 * @returns {{ cleanBody: string, images: { url: string, name: string|null }[], audio: { url: string, name: string }[] }}
 */
function _parseReleaseBody(body) {
  const images = [];
  const audio = [];
  const seenUrls = new Set();

  const addImage = (url, name) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    images.push({ url, name: name || null });
  };
  const addAudio = (url, name) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    audio.push({ url, name });
  };

  for (const url of _extractMarkdownImageUrls(body)) addImage(url, null);
  for (const img of _extractHtmlImageSources(body)) addImage(img.url, img.name);
  for (const track of _extractMarkdownAudioLinks(body)) addAudio(track.url, track.name);

  let cleanBody = body
    .replace(MARKDOWN_IMG_RE, '')
    .replace(HTML_IMG_SRC_RE, '')
    .replace(MARKDOWN_AUDIO_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanBody, images, audio };
}

function _guessAudioMimetype(filename, url) {
  const source = (filename || url || '').toLowerCase();
  const ext = source.split('.').pop()?.split('?')[0];
  return EXT_AUDIO_MIME[ext] || 'audio/mpeg';
}

/**
 * Download remote media and return a MessageMedia object, or null on failure.
 * @param {string} url
 * @param {string|null} name
 * @param {object} headers - Auth headers for GitHub
 * @param {'image'|'audio'} kind
 * @returns {Promise<import('whatsapp-web.js').MessageMedia|null>}
 */
async function _fetchReleaseMedia(url, name, headers, kind) {
  try {
    const res = await fetchWithTimeout(url, { headers }, 15_000);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    let mimetype = res.headers.get('content-type')?.split(';')[0].trim() || '';

    if (kind === 'image') {
      if (!mimetype.startsWith('image/')) {
        if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url)) {
          mimetype = 'image/jpeg';
        } else {
          return null;
        }
      }
    } else if (kind === 'audio') {
      if (!mimetype.startsWith('audio/')) {
        if (mimetype === 'application/octet-stream' || !mimetype) {
          mimetype = _guessAudioMimetype(name, url);
        } else {
          return null;
        }
      }
    }

    const filename = name || url.split('/').pop().split('?')[0] || (kind === 'image' ? 'image.jpg' : 'audio.mp3');
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
      if (res.status !== 404) log.error(`GitHub API error: ${res.status}`);
      return;
    }

    const release = await res.json();
    if (!release || !release.id) return;

    const releaseId = String(release.id);

    // First run: just store the current release, don't notify
    if (lastCheckedReleaseId === null) {
      lastCheckedReleaseId = releaseId;
      await _saveState();
      log.info(`Initial release recorded: ${release.tag_name}`);
      return;
    }

    if (releaseId === lastCheckedReleaseId) return;

    // New release detected
    lastCheckedReleaseId = releaseId;
    await _saveState();

    const title = release.name || release.tag_name || 'Nuova release';
    const body = release.body || '';

    const { cleanBody, images: inlineImages, audio: inlineAudio } = _parseReleaseBody(body);

    const message = `${RELEASE_NOTIFICATION_PREFIX} ${title}*\n\n${cleanBody}`.trim();

    const seenUrls = new Set([
      ...inlineImages.map(i => i.url),
      ...inlineAudio.map(a => a.url),
    ]);

    const assetImages = [];
    const assetAudio = [];
    for (const a of release.assets || []) {
      const url = a.browser_download_url;
      if (!url || seenUrls.has(url)) continue;
      if (a.content_type?.startsWith('image/')) {
        seenUrls.add(url);
        assetImages.push({ url, name: a.name });
      } else if (a.content_type?.startsWith('audio/')) {
        seenUrls.add(url);
        assetAudio.push({ url, name: a.name });
      }
    }

    const allImageSources = [...inlineImages, ...assetImages];
    const allAudioSources = [...inlineAudio, ...assetAudio];

    const imageMediaItems = [];
    for (const img of allImageSources) {
      const media = await _fetchReleaseMedia(img.url, img.name, authHeaders, 'image');
      if (media) imageMediaItems.push(media);
    }

    const audioMediaItems = [];
    for (const track of allAudioSources) {
      const media = await _fetchReleaseMedia(track.url, track.name, authHeaders, 'audio');
      if (media) audioMediaItems.push(media);
    }

    const mediaCount = imageMediaItems.length + audioMediaItems.length;
    if (mediaCount > 0) {
      log.info(
        `${imageMediaItems.length} image(s), ${audioMediaItems.length} audio file(s) for release ${title}`,
      );
    }

    const subscribedChats = getSubscribedChats();
    if (subscribedChats.size === 0) {
      log.info(`New release ${title} detected, but no subscribed chats.`);
      return;
    }

    log.info(`New release ${title} - sending to ${subscribedChats.size} chat(s)...`);

    for (const [chatId, waJid] of subscribedChats) {
      try {
        await waClient.sendMessage(waJid, message);
        for (const media of imageMediaItems) {
          try {
            await waClient.sendMessage(waJid, media);
          } catch (imgErr) {
            log.warn(`Release image send error to ${waJid}: ${imgErr.message}`);
          }
        }
        for (const media of audioMediaItems) {
          try {
            await waClient.sendMessage(waJid, media);
          } catch (audioErr) {
            log.warn(`Release audio send error to ${waJid}: ${audioErr.message}`);
          }
        }
      } catch (err) {
        log.error(`Release send error to ${waJid} (chat ${chatId}):`, err.message);
      }
    }
  } catch (err) {
    log.error('Release check error:', err.message);
  }
}

module.exports = { checkNewRelease };
