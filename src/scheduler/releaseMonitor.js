// src/scheduler/releaseMonitor.js
//
// Durable GitHub release notifications. The release payload and every
// recipient/component receipt are persisted before the global release cursor
// advances, so transient chat failures remain retryable across scheduler ticks
// and process restarts.

import path from 'node:path';
import envConfig from '../config/env.js';
import { getSubscribedChats } from '../tools/releaseNotify.js';
import { fetchWithTimeout, readWebResponseBodyWithLimit } from '../utils/fetch.js';
import { createLogger } from '../utils/logger.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import { get as getSystemState, update as updateSystemState } from '../utils/systemState.js';
import { RELEASE_NOTIFICATION_PREFIX } from '../config/systemMessages.js';
import { mimeBase, mimeForExtension } from '../config/mimeExtensions.js';
import { mediaFamilyFor } from '../config/mediaTypes.js';
import { sniffImageType } from '../utils/imageType.js';
import { WA_DIRECT_MAX_BYTES } from '../utils/attachments.js';

const log = createLogger('ReleaseMonitor');
const OUTBOX_VERSION = 1;
const RELEASE_MEDIA_MAX_BYTES = WA_DIRECT_MAX_BYTES;
const COMPONENT_ERROR_MAX_CHARS = 500;

let activeCheck = null;

const AUDIO_FILE_EXT = '(?:mp3|wav|ogg|m4a|aac|flac|opus|webm|oga)';
const HTML_IMG_SRC_RE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi;
const MARKDOWN_IMG_RE = /!\[.*?\]\((https?:\/\/[^)\s]+)\)/g;
const MARKDOWN_AUDIO_RE = new RegExp(
  `\\[([^\\]]+\\.${AUDIO_FILE_EXT})\\]\\((https?:\\/\\/[^)\\s]+)\\)`,
  'gi'
);

function _shortError(err) {
  return String(err?.message || err || 'unknown error').slice(0, COMPONENT_ERROR_MAX_CHARS);
}

function _extractMarkdownImageUrls(markdown) {
  const urls = [];
  let match;
  while ((match = MARKDOWN_IMG_RE.exec(markdown)) !== null) urls.push(match[1]);
  return urls;
}

function _extractHtmlImageSources(markdown) {
  const items = [];
  let match;
  while ((match = HTML_IMG_SRC_RE.exec(markdown)) !== null) {
    const altMatch = /\balt=["']([^"']*)["']/i.exec(match[0]);
    items.push({ url: match[1], name: altMatch?.[1]?.trim() || null });
  }
  return items;
}

function _extractMarkdownAudioLinks(markdown) {
  const items = [];
  let match;
  while ((match = MARKDOWN_AUDIO_RE.exec(markdown)) !== null) {
    items.push({ url: match[2], name: match[1].trim() });
  }
  return items;
}

function _parseReleaseBody(body) {
  const source = typeof body === 'string' ? body : '';
  const images = [];
  const audio = [];
  const seenUrls = new Set();

  const add = (target, url, name) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    target.push({ url, name: name || null });
  };
  for (const url of _extractMarkdownImageUrls(source)) add(images, url, null);
  for (const item of _extractHtmlImageSources(source)) add(images, item.url, item.name);
  for (const item of _extractMarkdownAudioLinks(source)) add(audio, item.url, item.name);

  const cleanBody = source
    .replace(MARKDOWN_IMG_RE, '')
    .replace(HTML_IMG_SRC_RE, '')
    .replace(MARKDOWN_AUDIO_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanBody, images, audio, seenUrls };
}

function _releaseMediaSources(release, parsed) {
  const sources = [
    ...parsed.images.map(item => ({ ...item, kind: 'image' })),
    ...parsed.audio.map(item => ({ ...item, kind: 'audio' }))
  ];
  const seen = new Set(sources.map(item => item.url));
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const url = asset?.browser_download_url;
    if (!url || seen.has(url)) continue;
    const kind = mediaFamilyFor({ name: asset.name, contentType: asset.content_type });
    if (kind !== 'image' && kind !== 'audio') continue;
    seen.add(url);
    sources.push({ url, name: asset.name || null, kind });
  }
  return sources;
}

function _pendingComponent() {
  return { status: 'pending', attempts: 0, method: null, lastError: null };
}

function _buildReleaseOutbox(release, subscribedChats) {
  const releaseId = String(release.id);
  const title = release.name || release.tag_name || 'Nuova release';
  const parsed = _parseReleaseBody(release.body || '');
  const message = `${RELEASE_NOTIFICATION_PREFIX} ${title}*\n\n${parsed.cleanBody}`.trim();
  const media = _releaseMediaSources(release, parsed);
  const recipients = {};
  for (const [chatId, waJid] of subscribedChats) {
    recipients[chatId] = {
      waJid,
      text: _pendingComponent(),
      media: media.map(() => _pendingComponent())
    };
  }
  return {
    version: OUTBOX_VERSION,
    releaseId,
    tagName: release.tag_name || null,
    title,
    message,
    media,
    createdAt: new Date().toISOString(),
    recipients
  };
}

function _isDelivered(component) {
  return component?.status === 'delivered';
}

function _outboxComplete(outbox) {
  if (!outbox || !outbox.recipients || typeof outbox.recipients !== 'object') return false;
  return Object.values(outbox.recipients).every(recipient =>
    _isDelivered(recipient.text)
    && Array.isArray(recipient.media)
    && recipient.media.length === outbox.media.length
    && recipient.media.every(_isDelivered)
  );
}

async function _persistOutbox(outbox) {
  await updateSystemState('releases', current => ({ ...current, releaseOutbox: outbox }));
}

async function _completeOutbox(outbox) {
  await updateSystemState('releases', current => {
    if (current.releaseOutbox?.releaseId !== outbox.releaseId) return current;
    const next = { ...current, lastReleaseId: outbox.releaseId };
    delete next.releaseOutbox;
    return next;
  });
}

function _filenameForSource(source) {
  if (source.name) return path.basename(String(source.name));
  try {
    const segment = decodeURIComponent(new URL(source.url).pathname.split('/').filter(Boolean).pop() || '');
    if (segment) return path.basename(segment);
  } catch { /* validated by fetch */ }
  return source.kind === 'image' ? 'release-image' : 'release-audio';
}

function _mediaMime(source, response, buffer, filename) {
  const headerMime = mimeBase(response.headers.get('content-type'));
  const extensionMime = mimeForExtension(path.extname(filename), '');
  if (source.kind === 'image') {
    const sniffed = sniffImageType(buffer)?.mime || '';
    const selected = sniffed
      || (headerMime.startsWith('image/') ? headerMime : '')
      || (extensionMime.startsWith('image/') ? extensionMime : '');
    if (!selected) throw new Error('Downloaded release image has an unsupported type.');
    return selected;
  }
  const selected = headerMime.startsWith('audio/')
    ? headerMime
    : (extensionMime.startsWith('audio/') ? extensionMime : '');
  if (!selected) throw new Error('Downloaded release audio has an unsupported type.');
  return selected;
}

async function _fetchReleaseMedia(source, headers) {
  const response = await fetchWithTimeout(source.url, { headers }, 15_000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await readWebResponseBodyWithLimit(response, RELEASE_MEDIA_MAX_BYTES);
  const filename = _filenameForSource(source);
  const mimetype = _mediaMime(source, response, buffer, filename);
  return new MessageMedia(mimetype, buffer.toString('base64'), filename);
}

function _fallbackMediaMessage(source) {
  const label = source.name ? `${source.name}\n` : '';
  return `Media della release non inviato direttamente:\n${label}${source.url}`;
}

async function _markSending(outbox, component, persistOutbox) {
  component.status = 'sending';
  component.attempts = (Number(component.attempts) || 0) + 1;
  component.lastError = null;
  await persistOutbox(outbox);
}

async function _markOutcome(outbox, component, outcome, persistOutbox) {
  const { delivered, method = null, error = null } = outcome;
  component.status = delivered ? 'delivered' : 'pending';
  component.method = delivered ? method : null;
  component.lastError = delivered ? null : _shortError(error);
  await persistOutbox(outbox);
}

async function _deliverMediaComponent(waClient, waJid, source, headers, fetchMedia) {
  try {
    const media = await fetchMedia(source, headers);
    await waClient.sendMessage(waJid, media);
    return { delivered: true, method: 'direct' };
  } catch (directError) {
    try {
      await waClient.sendMessage(waJid, _fallbackMediaMessage(source));
      return { delivered: true, method: 'link' };
    } catch (fallbackError) {
      return {
        delivered: false,
        error: `Direct media delivery failed: ${_shortError(directError)}; link fallback failed: ${_shortError(fallbackError)}`
      };
    }
  }
}

async function _drainReleaseOutbox(waClient, outbox, headers, options = {}) {
  const fetchMedia = options.fetchMedia || _fetchReleaseMedia;
  const persistOutbox = options.persistOutbox || _persistOutbox;
  const completeOutbox = options.completeOutbox || _completeOutbox;
  for (const [chatId, recipient] of Object.entries(outbox.recipients || {})) {
    const waJid = recipient?.waJid;
    if (!waJid) {
      log.error(`Release outbox recipient ${chatId} has no WhatsApp JID.`);
      continue;
    }
    if (!_isDelivered(recipient.text)) {
      await _markSending(outbox, recipient.text, persistOutbox);
      try {
        await waClient.sendMessage(waJid, outbox.message);
        await _markOutcome(outbox, recipient.text, { delivered: true, method: 'text' }, persistOutbox);
      } catch (err) {
        await _markOutcome(outbox, recipient.text, { delivered: false, error: err }, persistOutbox);
        log.warn(`Release text send error to ${waJid} (chat ${chatId}): ${_shortError(err)}`);
        continue;
      }
    }

    for (let index = 0; index < outbox.media.length; index++) {
      const component = recipient.media[index];
      if (_isDelivered(component)) continue;
      await _markSending(outbox, component, persistOutbox);
      const outcome = await _deliverMediaComponent(
        waClient,
        waJid,
        outbox.media[index],
        headers,
        fetchMedia
      );
      await _markOutcome(outbox, component, outcome, persistOutbox);
      if (!outcome.delivered) {
        log.warn(`Release media send error to ${waJid} (chat ${chatId}): ${_shortError(outcome.error)}`);
      }
    }
  }

  if (_outboxComplete(outbox)) {
    await completeOutbox(outbox);
    log.info(`Release ${outbox.title} delivered to every queued chat.`);
    return true;
  }
  return false;
}

function _authHeaders() {
  return {
    Authorization: `Bearer ${envConfig.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'GemiX-Bot'
  };
}

async function _fetchLatestRelease(headers) {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${envConfig.GITHUB_REPO}/releases/latest`,
    { headers },
    15_000
  );
  if (!response.ok) {
    if (response.status !== 404) log.error(`GitHub API error: ${response.status}`);
    return null;
  }
  const release = await response.json();
  return release?.id ? release : null;
}

async function _checkNewRelease(waClient) {
  if (!envConfig.GITHUB_TOKEN || !envConfig.GITHUB_REPO || !waClient) return;
  const headers = _authHeaders();

  let state = getSystemState('releases') || {};
  if (state.releaseOutbox) {
    const complete = await _drainReleaseOutbox(waClient, state.releaseOutbox, headers);
    if (!complete) return;
    state = getSystemState('releases') || {};
  }

  const release = await _fetchLatestRelease(headers);
  if (!release) return;
  const releaseId = String(release.id);

  if (!state.lastReleaseId) {
    await updateSystemState('releases', current => ({ ...current, lastReleaseId: releaseId }));
    log.info(`Initial release recorded: ${release.tag_name || releaseId}`);
    return;
  }
  if (releaseId === String(state.lastReleaseId)) return;

  const subscribedChats = getSubscribedChats();
  if (subscribedChats.size === 0) {
    await updateSystemState('releases', current => ({ ...current, lastReleaseId: releaseId }));
    log.info(`New release ${release.name || release.tag_name || releaseId} detected, but no subscribed chats.`);
    return;
  }

  const outbox = _buildReleaseOutbox(release, subscribedChats);
  await _persistOutbox(outbox);
  log.info(`New release ${outbox.title} - queued for ${subscribedChats.size} chat(s).`);
  await _drainReleaseOutbox(waClient, outbox, headers);
}

/** Scheduler entry point; overlapping ticks share one durable drain. */
function checkNewRelease(waClient) {
  if (activeCheck) return activeCheck;
  activeCheck = _checkNewRelease(waClient)
    .catch(err => log.error(`Release check error: ${_shortError(err)}`))
    .finally(() => { activeCheck = null; });
  return activeCheck;
}

export {
  RELEASE_MEDIA_MAX_BYTES,
  checkNewRelease,
  _parseReleaseBody,
  _buildReleaseOutbox,
  _fetchReleaseMedia,
  _drainReleaseOutbox,
  _outboxComplete
};
