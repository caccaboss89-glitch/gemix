// Shared ingress helpers: classify attachments and turn synced history files
// into native content parts + attachment-tag text (Discord + WA quote/current).

const { buildAttachmentTag, isSupportedMedia } = require('./media');
const { deliverSyncedAttachment } = require('./aiFileDelivery');
const { resolveIngressFilename } = require('./attachmentFilenames');
const { syncFileToHistory, resolveGemixVoiceTranscription } = require('./historySync');
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
 */
async function ingressWaMessageMedia(msg, historyStorageId, options = {}) {
  const { chatId, isGemixVoice = false } = options;
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
  const isAudioType = mediaType === 'audio' || mediaType === 'ptt';

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
    registerTunnel: options.historyTagOnly !== true,
    getVoiceTranscription: isGemixVoice && isAudioType
      ? async () => resolveGemixVoiceTranscription(
        historyStorageId, syncedPath, chatId, (msg.timestamp || 0) * 1000,
      )
      : null,
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

async function ingressSyncedAttachment(opts) {
  const { historyTagOnly, ...rest } = opts;
  return deliverSyncedAttachment({
    ...rest,
    ownerKey: opts.historyStorageId,
    registerTunnel: historyTagOnly !== true,
  });
}

/**
 * Sync + classify one Discord attachment (current turn, quote, or history rebuild).
 */
async function ingressDiscordAttachment(att, historyStorageId, options = {}) {
  const { getVoiceTranscription = null, metadataDurationSec = 0, historyTagOnly = false } = options;

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

  const ingress = await ingressSyncedAttachment({
    syncedPath,
    name: ingressName,
    contentType: att.contentType || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec,
    historyTagOnly,
    getVoiceTranscription: typeof getVoiceTranscription === 'function'
      ? async () => getVoiceTranscription(syncedPath)
      : null,
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath,
    name: ingressName,
  };
}

module.exports = {
  createMemoizedFetchBuffer,
  ingressWaMessageMedia,
  ingressSyncedAttachment,
  ingressDiscordAttachment,
};