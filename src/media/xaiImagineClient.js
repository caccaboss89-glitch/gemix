// src/media/xaiImagineClient.js
//
// The complete direct xAI Imagine HTTP boundary.
//
// Callers hand this module validated prompts and reference-image URLs/data URLs. It
// owns the xAI request shapes, OAuth-backed submit calls, asynchronous video
// polling, generated-media downloads, response validation and xAI failure
// classification. Workspace paths, quota accounting and output staging stay
// in the provider-neutral tool orchestrator.

import constants from '../config/constants.js';
import { callApiWithRetry, fetchXaiWithOAuthRetry } from '../ai/apiClient.js';
import { getXaiServiceAuth } from '../ai/credentials/xaiServiceCredentials.js';
import { downloadPublicFile } from '../utils/fetch.js';
import { buildAdminNotificationNote, notifyAdminDetailed } from '../utils/adminNotifier.js';
import { sniffImageType } from '../utils/imageType.js';
import { sniffVideoType } from '../utils/videoType.js';
import { createLogger } from '../utils/logger.js';
import { sleepWithin } from '../utils/turnBudget.js';

const log = createLogger('XaiImagine');

const IMAGINE_SUBMIT_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_POLL_FETCH_TIMEOUT_MS = 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_429_POLLS = 5;
const GENERATED_MEDIA_MAX_BYTES = constants.MAX_VIDEO_BYTES;

const VIDEO_IN_PROGRESS_STATUSES = new Set([
  '', 'pending', 'processing', 'queued', 'running', 'in_progress', 'in progress'
]);
// xAI documents expired jobs as terminal failures alongside failed jobs.
const VIDEO_TERMINAL_FAILURE_STATUSES = new Set([
  'failed', 'expired', 'error', 'rejected', 'cancelled', 'canceled'
]);

/** Map an xAI failure onto the image fallback policy's shared vocabulary. */
function classifyXaiFailure(message) {
  const normalized = String(message || '');
  if (/content policy|moderation|safety|prohibited|violat/i.test(normalized)) return 'CONTENT_POLICY';
  if (/\b429\b|rate.?limit|too many requests|quota|credit/i.test(normalized)) return 'RATE_LIMIT';
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.*(key|token)/i.test(normalized)) return 'AUTH';
  if (/\b5\d{2}\b|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i.test(normalized)) {
    return 'TRANSIENT';
  }
  return 'MALFORMED';
}

/** Build the documented xAI image generation/edit request. */
function buildXaiImageRequest({ model, prompt, referenceImages = [], aspectRatio = null }) {
  const body = { model, prompt, response_format: 'url' };
  if (referenceImages.length === 0) {
    if (aspectRatio !== null) body.aspect_ratio = aspectRatio;
    return { endpointPath: '/images/generations', body };
  }
  if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: 'image_url' };
  } else {
    body.images = referenceImages.map(url => ({ type: 'image_url', url }));
  }
  return { endpointPath: '/images/edits', body };
}

/** Build the documented xAI asynchronous video request. */
function buildXaiVideoRequest({
  model,
  prompt,
  referenceImages = [],
  aspectRatio,
  duration,
  resolution
}) {
  const body = { model, prompt, duration, resolution };
  if (referenceImages.length === 0) {
    body.aspect_ratio = aspectRatio;
  } else if (referenceImages.length === 1) {
    body.image = { url: referenceImages[0], type: 'image_url' };
  } else {
    body.reference_images = referenceImages.map(url => ({ type: 'image_url', url }));
  }
  return { endpointPath: '/videos/generations', body };
}

async function _xaiJsonRequest(label, endpointPath, body, timeoutMs, signal) {
  const { baseUrl } = await getXaiServiceAuth();
  const url = `${baseUrl}${endpointPath}`;
  const res = await callApiWithRetry(label, url, body, {}, timeoutMs, { signal });
  return res.json();
}

async function _downloadMedia(url, signal) {
  const result = await downloadPublicFile(url, {
    signal,
    timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
    maxBytes: GENERATED_MEDIA_MAX_BYTES
  });
  return result.buffer;
}

/** Generate and download one xAI Imagine image. */
async function generateXaiImage({ model, prompt, referenceImages = [], aspectRatio = null, signal }) {
  let data;
  try {
    const request = buildXaiImageRequest({ model, prompt, referenceImages, aspectRatio });
    data = await _xaiJsonRequest(
      'Grok-Imagine-Image',
      request.endpointPath,
      request.body,
      IMAGINE_SUBMIT_TIMEOUT_MS,
      signal
    );
  } catch (err) {
    return { ok: false, error: err.message, code: classifyXaiFailure(err.message) };
  }

  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (!item || typeof item.url !== 'string') {
    const notification = await notifyAdminDetailed(
      'GenerateImage',
      `No media URL in response: ${JSON.stringify(data).slice(0, 300)}`
    );
    return {
      ok: false,
      error: `Image generation produced no media URL.${buildAdminNotificationNote(notification)}`,
      code: 'MALFORMED'
    };
  }

  let buffer;
  try {
    buffer = await _downloadMedia(item.url, signal);
  } catch (err) {
    return { ok: false, error: `Image load failed: ${err.message}`, code: 'TRANSIENT' };
  }
  const type = sniffImageType(buffer);
  if (!type) {
    return { ok: false, error: 'Image generation returned an unrecognized image format.', code: 'MALFORMED' };
  }
  return { ok: true, buffer, ext: type.ext };
}

function _isRetryablePollHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function _isRetryablePollException(err) {
  const message = err?.message || '';
  const statusMatch = /^HTTP (\d{3})\b/.exec(message);
  if (statusMatch) return _isRetryablePollHttpStatus(Number(statusMatch[1]));
  return /ECONNRESET|ECONNREFUSED|ERR_NETWORK|fetch failed|network|socket hang up/i.test(message);
}

function _videoPollFailureMessage(data, status) {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (data?.error?.message) return String(data.error.message);
  if (data?.message) return String(data.message);
  return `generation status "${status || 'failed'}"`;
}

/** Poll one asynchronous Imagine video job until it yields a media URL. */
async function pollXaiVideoResult(requestId, signal) {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  const label = 'Grok-Imagine-Video-Poll';
  let consecutive429 = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');

    const { baseUrl } = await getXaiServiceAuth();
    const url = `${baseUrl}/videos/${encodeURIComponent(requestId)}`;
    let data;
    try {
      const res = await fetchXaiWithOAuthRetry(url, { method: 'GET' }, {
        timeoutMs: VIDEO_POLL_FETCH_TIMEOUT_MS,
        signal,
        logLabel: label
      });
      consecutive429 = 0;
      data = await res.json();
    } catch (err) {
      const message = err?.message || '';
      if (/^HTTP 429\b/.test(message)) {
        consecutive429 += 1;
        if (consecutive429 >= MAX_CONSECUTIVE_429_POLLS) {
          throw new Error(`Rate limited too many times (${MAX_CONSECUTIVE_429_POLLS} consecutive 429s): ${message}`);
        }
      } else {
        consecutive429 = 0;
      }
      if (!_isRetryablePollException(err)) throw err;
      log.warn(`   video poll retry (${requestId}): ${message}`);
      await sleepWithin(VIDEO_POLL_INTERVAL_MS, signal);
      continue;
    }

    const status = String(data?.status || '').toLowerCase();
    if (status === 'done') {
      const videoUrl = data?.video?.url;
      if (typeof videoUrl !== 'string' || !videoUrl) {
        throw new Error('status "done" but no video URL in response');
      }
      return videoUrl;
    }
    if (VIDEO_TERMINAL_FAILURE_STATUSES.has(status) || data?.error) {
      throw new Error(_videoPollFailureMessage(data, status));
    }
    if (!VIDEO_IN_PROGRESS_STATUSES.has(status)) {
      throw new Error(_videoPollFailureMessage(data, status || 'unknown'));
    }
    log.debug(`   video ${requestId}: status=${status || 'pending'}`);
    await sleepWithin(VIDEO_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Timed out after ${Math.round(VIDEO_POLL_TIMEOUT_MS / 1000)}s waiting for the video.`);
}

/** Submit, poll and download one xAI Imagine video. */
async function generateXaiVideo({
  model,
  prompt,
  referenceImages = [],
  aspectRatio,
  duration,
  resolution,
  signal
}) {
  let submit;
  try {
    const request = buildXaiVideoRequest({
      model,
      prompt,
      referenceImages,
      aspectRatio,
      duration,
      resolution
    });
    submit = await _xaiJsonRequest(
      'Grok-Imagine-Video',
      request.endpointPath,
      request.body,
      IMAGINE_SUBMIT_TIMEOUT_MS,
      signal
    );
  } catch (err) {
    return { ok: false, error: `Video generation failed: ${err.message}` };
  }

  const requestId = submit?.request_id;
  if (!requestId || typeof requestId !== 'string') {
    const notification = await notifyAdminDetailed(
      'GenerateVideo',
      `No request_id in response: ${JSON.stringify(submit).slice(0, 300)}`
    );
    return {
      ok: false,
      error: `Video generation did not return a request id.${buildAdminNotificationNote(notification)}`
    };
  }

  let videoUrl;
  try {
    videoUrl = await pollXaiVideoResult(requestId, signal);
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, error: 'Video generation stopped because this turn ended.' };
    }
    const notification = await notifyAdminDetailed('GenerateVideo', `Polling ${requestId} failed: ${err.message}`);
    return {
      ok: false,
      error: `Video generation failed: ${err.message}${buildAdminNotificationNote(notification)}`
    };
  }

  let buffer;
  try {
    buffer = await _downloadMedia(videoUrl, signal);
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, error: 'Video download stopped because this turn ended.' };
    }
    const notification = await notifyAdminDetailed(
      'GenerateVideo',
      `Load media from ${videoUrl} failed: ${err.message}`
    );
    return {
      ok: false,
      error: `Video load failed: ${err.message}${buildAdminNotificationNote(notification)}`
    };
  }

  const type = sniffVideoType(buffer);
  if (!type) {
    return { ok: false, error: 'Video generation returned an unrecognized video container.' };
  }

  return {
    ok: true,
    buffer,
    ext: type.ext
  };
}

export {
  buildXaiImageRequest,
  buildXaiVideoRequest,
  classifyXaiFailure,
  generateXaiImage,
  generateXaiVideo,
  pollXaiVideoResult
};
