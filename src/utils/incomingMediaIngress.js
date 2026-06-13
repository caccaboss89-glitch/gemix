// Shared ingress helpers: classify attachments and turn synced history files
// into native content parts + attachment-tag text (Discord + WA quote/current).

const { buildAttachmentTag, isSupportedMedia } = require('./media');
const { deliverSyncedAttachment } = require('./aiFileDelivery');
const { resolveIngressFilename } = require('./attachmentFilenames');
const { syncFileToHistory } = require('./historySync');
const {
  createDiscordAttachmentBufferFetcher,
  isDiscordAttachmentOversize,
  formatDiscordOversizeNote,
} = require('./discordAttachmentFetch');

function createMemoizedFetchBuffer(fetchOnce) {
  let promise = null;
  return async () => {
    if (!promise) promise = fetchOnce();
    return promise;
  };
}

/**
 * Sync + classify one WhatsApp message attachment (history or current turn).
 * @param {object} msg - whatsapp-web.js message
 * @param {string} historyStorageId
 * @param {object} [options]
 * @param {boolean} [options.tagOnly] - tag without native parts (assistant-side
 *   history entries whose role cannot carry input parts).
 */
async function ingressWaMessageMedia(msg, historyStorageId, options = {}) {
  const mediaType = msg.type;
  const waFilename = msg._data?.filename;
  const mimetypeHint = msg._data?.mimetype || null;
  const msgId = msg.id?.id;

  if (!isSupportedMedia(mediaType)) {
    const fallbackName = resolveIngressFilename(waFilename, mimetypeHint, msgId);
    const tag = buildAttachmentTag(null, fallbackName || waFilename);
    return {
      tag,
      textFragment: `${tag} `,
      contentParts: [],
      syncedPath: null,
      mimetype: mimetypeHint,
      filename: waFilename,
      unsupported: true,
      fetchBuffer: null,
    };
  }

  if (!msgId) {
    const tag = buildAttachmentTag(null, waFilename || 'file');
    return {
      tag,
      textFragment: `${tag} `,
      contentParts: [],
      syncedPath: null,
      mimetype: mimetypeHint,
      filename: waFilename,
      unsupported: true,
      fetchBuffer: null,
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

  const ingress = await deliverSyncedAttachment({
    syncedPath,
    name: filename,
    contentType: mimetype || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec: duration,
    ownerKey: historyStorageId,
    tagOnly: options.tagOnly === true,
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath,
    mimetype,
    filename,
    overDurationLimit: ingress.overDurationLimit || null,
    durationNote: ingress.durationNote || null,
    fetchBuffer,
  };
}

/**
 * Sync + classify one Discord attachment (current turn, quote, or history rebuild).
 */
async function ingressDiscordAttachment(att, historyStorageId, options = {}) {
  const { metadataDurationSec = 0, tagOnly = false } = options;

  if (isDiscordAttachmentOversize(att)) {
    const tag = buildAttachmentTag(null, att.name);
    return {
      tag,
      textFragment: `${tag}${formatDiscordOversizeNote(att)} `,
      contentParts: [],
      syncedPath: null,
      oversize: true,
    };
  }

  const ingressName = resolveIngressFilename(att.name, att.contentType || '', att.id);
  const fetchBuffer = createDiscordAttachmentBufferFetcher(att);
  let syncedPath = null;
  try {
    syncedPath = await syncFileToHistory(historyStorageId, att.id, fetchBuffer, ingressName);
  } catch { /* tag-only */ }

  const ingress = await deliverSyncedAttachment({
    syncedPath,
    name: ingressName,
    contentType: att.contentType || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec,
    ownerKey: historyStorageId,
    tagOnly,
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath,
    name: ingressName,
  };
}

/**
 * Cap the number of input_image parts across rebuilt history messages.
 * Walks from the NEWEST message backwards keeping up to `max` images; older
 * image parts are dropped (their [Attachment] tag text remains, so the model
 * can still read_file them on demand). Documents (input_file) are not capped:
 * xAI handles them with server-side retrieval at negligible token cost,
 * while every attached image is processed by vision on each call.
 *
 * @param {Array} historyMessages - chat-completion messages (content string or parts array).
 * @param {number} max
 */
function capHistoryImageParts(historyMessages, max) {
  if (!Array.isArray(historyMessages)) return;
  let kept = 0;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const content = [];
    for (const part of msg.content) {
      if (part && part.type === 'input_image') {
        if (kept >= max) continue;
        kept++;
      }
      content.push(part);
    }
    if (content.length === 1 && content[0].type === 'text') {
      msg.content = content[0].text;
    } else {
      msg.content = content;
    }
  }
}

module.exports = {
  createMemoizedFetchBuffer,
  ingressWaMessageMedia,
  ingressDiscordAttachment,
  capHistoryImageParts,
};
