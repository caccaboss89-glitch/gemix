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
    platformAttachmentId: msgId,
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath: ingress.syncedPath ?? syncedPath,
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
    platformAttachmentId: att.id,
  });

  return {
    tag: ingress.tag,
    textFragment: ingress.textFragment,
    contentParts: ingress.contentParts,
    syncedPath: ingress.syncedPath ?? syncedPath,
    name: ingressName,
  };
}

/**
 * Cap the native file parts re-attached from history, independently per kind:
 *   - input_image: vision-processed on every call (expensive) → keep newest `maxImages`
 *   - input_file:  documents/audio/video → keep newest `maxFiles`
 * Walks from the NEWEST message backwards. Dropped parts leave their
 * [Attachment] tag text (plus a marker) so the model knows the file exists but
 * was not loaded this turn. GemiX voice-note transcripts are NOT affected: they
 * are attached to the current user turn (not history) and always ship.
 *
 * @param {Array} historyMessages - chat-completion messages (content string or parts array).
 * @param {number} maxImages
 * @param {number} [maxFiles] - defaults to maxImages when omitted.
 */
function capHistoryImageParts(historyMessages, maxImages, maxFiles) {
  if (!Array.isArray(historyMessages)) return;
  const imageCap = Number.isFinite(maxImages) ? maxImages : 0;
  const fileCap = Number.isFinite(maxFiles) ? maxFiles : imageCap;
  let keptImages = 0;
  let keptFiles = 0;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const content = [];
    let droppedImages = 0;
    let droppedFiles = 0;
    for (const part of msg.content) {
      if (part && part.type === 'input_image') {
        if (keptImages >= imageCap) { droppedImages++; continue; }
        keptImages++;
      } else if (part && part.type === 'input_file') {
        if (keptFiles >= fileCap) { droppedFiles++; continue; }
        keptFiles++;
      }
      content.push(part);
    }
    // Mark the text part when older media was dropped, so the model knows the
    // file exists but was not loaded this turn (the main brain has no read_file
    // to fetch it on demand).
    if (droppedImages > 0 || droppedFiles > 0) {
      const textPart = content.find(p => p && p.type === 'text');
      if (textPart && typeof textPart.text === 'string' && !textPart.text.includes('not shown this turn')) {
        const kinds = [];
        if (droppedImages > 0) kinds.push('image(s)');
        if (droppedFiles > 0) kinds.push('file(s)');
        textPart.text += ` (older ${kinds.join(' and ')} not shown this turn — newest ${imageCap} images / ${fileCap} files per call; ask to resend or reply to it to view)`;
      }
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
