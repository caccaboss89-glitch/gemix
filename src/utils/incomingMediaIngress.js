// Shared ingress helpers: sync one platform attachment into history, project it
// into `attachments/`, and return its tag plus — for an inline image — the
// content part (Discord + WhatsApp, current message, quote and history).

import { isSupportedMedia  } from './media.js';
import { buildAttachmentTag, ingestAttachment  } from '../attachments/ingress.js';
import { resolveIngressFilename  } from './attachmentFilenames.js';
import { syncFileToHistory  } from './historySync.js';
import {
  createDiscordAttachmentBufferFetcher,
  isDiscordAttachmentOversize,
  formatDiscordOversizeNote
} from './discordAttachmentFetch.js';

function createMemoizedFetchBuffer(fetchOnce) {
  let promise = null;
  return async () => {
    if (!promise) promise = fetchOnce();
    return promise;
  };
}

/**
 * Sync + project one WhatsApp message attachment (history or current turn).
 * @param {object} msg - whatsapp-web.js message
 * @param {string} historyStorageId
 * @param {object} [options]
 * @param {string} [options.workspaceId] - conversation whose projection to fill
 * @param {boolean} [options.inline] - the message being answered, or the one it
 *   replies to: only those may carry an image natively.
 * @param {number} [options.imagesInlined] - running per-turn inline image count
 */
async function ingressWaMessageMedia(msg, historyStorageId, options = {}) {
  const mediaType = msg.type;
  const waFilename = msg._data?.filename;
  const mimetypeHint = msg._data?.mimetype || null;
  const msgId = msg.id?.id;

  if (!isSupportedMedia(mediaType)) {
    const fallbackName = resolveIngressFilename(waFilename, mimetypeHint, msgId);
    const tag = buildAttachmentTag(fallbackName || waFilename || 'file', true);
    return {
      tag,
      textFragment: `${tag} `,
      contentParts: [],
      syncedPath: null,
      mimetype: mimetypeHint,
      filename: waFilename,
      unsupported: true,
      fetchBuffer: null
    };
  }

  if (!msgId) {
    const tag = buildAttachmentTag(waFilename || 'file', true);
    return {
      tag,
      textFragment: `${tag} `,
      contentParts: [],
      syncedPath: null,
      mimetype: mimetypeHint,
      filename: waFilename,
      unsupported: true,
      fetchBuffer: null
    };
  }
  const filename = resolveIngressFilename(waFilename, mimetypeHint, msgId);
  const duration = Number(msg.duration || msg._data?.duration || 0);

  let mimetype = mimetypeHint;
  const fetchBuffer = createMemoizedFetchBuffer(async () => {
    const media = await msg.downloadMedia();
    if (!media) return null;
    if (media.mimetype) mimetype = media.mimetype;
    return Buffer.from(media.data, 'base64');
  });

  let syncedPath = null;
  try {
    syncedPath = await syncFileToHistory(historyStorageId, msgId, fetchBuffer, filename);
  } catch { /* tag-only */ }

  const ingress = await ingestAttachment({
    workspaceId: options.workspaceId || null,
    syncedPath,
    name: filename,
    contentType: mimetype || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec: duration,
    inline: options.inline === true,
    imagesInlined: options.imagesInlined || 0,
    platformAttachmentId: msgId
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath: ingress.syncedPath ?? syncedPath,
    mimetype,
    filename,
    overDurationLimit: ingress.overDurationLimit || null,
    fetchBuffer
  };
}

/**
 * Sync + project one Discord attachment (current turn, quote, or history rebuild).
 */
async function ingressDiscordAttachment(att, historyStorageId, options = {}) {
  const { metadataDurationSec = 0, inline = false, imagesInlined = 0 } = options;

  if (isDiscordAttachmentOversize(att)) {
    const tag = buildAttachmentTag(att.name, true);
    return {
      tag,
      textFragment: `${tag}${formatDiscordOversizeNote(att)} `,
      contentParts: [],
      syncedPath: null,
      oversize: true
    };
  }

  const ingressName = resolveIngressFilename(att.name, att.contentType || '', att.id);
  const fetchBuffer = createDiscordAttachmentBufferFetcher(att);
  let syncedPath = null;
  try {
    syncedPath = await syncFileToHistory(historyStorageId, att.id, fetchBuffer, ingressName);
  } catch { /* tag-only */ }

  const ingress = await ingestAttachment({
    workspaceId: options.workspaceId || null,
    syncedPath,
    name: ingressName,
    contentType: att.contentType || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec,
    inline,
    imagesInlined,
    platformAttachmentId: att.id
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath: ingress.syncedPath ?? syncedPath,
    name: ingressName
  };
}

export {
  ingressWaMessageMedia,
  ingressDiscordAttachment
};
