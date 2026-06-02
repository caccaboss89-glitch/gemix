// Shared ingress helpers: classify attachments and turn synced history files
// into native content parts + attachment-tag text (Discord + WA quote/current).

const {
  mediaToContentPart,
  buildAttachmentTag,
  isInlineableTextFile,
  buildInlineTextFilePart,
  isSupportedMedia,
} = require('./media');
const {
  formatAudioTooLongNote,
  formatVideoTooLongNote,
  isAudioOverDurationLimit,
  isVideoOverDurationLimit,
  resolveMediaDurationSec,
} = require('./mediaIngressLimits');
const { resolveIngressFilename } = require('./attachmentFilenames');
const { syncFileToHistory, resolveGemixVoiceTranscription } = require('./historySync');

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
 * @param {string} [options.chatId] - for GemiX voice transcription cache
 * @param {boolean} [options.isGemixVoice] - fromMe GemiX TTS voice on dedicated WA only
 * @returns {Promise<{ tag: string, textFragment: string, contentParts: Array, syncedPath, mimetype, filename, unsupported?: boolean }>}
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

  const ingress = await ingressSyncedAttachment({
    syncedPath,
    name: filename,
    contentType: mimetype || '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec: duration,
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
  };
}

function classifyAttachment(name, contentType) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const ct = contentType || '';
  return {
    ext,
    isImage: ct.startsWith('image/'),
    isAudio: ct.startsWith('audio/'),
    isVideo: ct.startsWith('video/'),
    isPdf: ct === 'application/pdf' || ext === 'pdf',
    isDoc: ct.startsWith('application/') || ['pdf', 'txt', 'doc', 'docx', 'csv', 'json'].includes(ext),
  };
}

/**
 * Turn a synced history file into zero or more native parts and a text fragment
 * (attachment tag, inline file, or duration note). Caller prepends to message body.
 *
 * @param {object} opts
 * @param {string|null} opts.syncedPath
 * @param {string} opts.name
 * @param {string} [opts.contentType]
 * @param {Function} opts.fetchBuffer - async () => Buffer|null
 * @param {string} opts.historyStorageId
 * @param {number} [opts.metadataDurationSec]
 * @param {Function|null} [opts.getVoiceTranscription] - async () => string|null (bot voice in quote)
 * @returns {Promise<{ tag: string, contentParts: Array, textFragment: string }>}
 */
function _durationSkipResult(tag, kind, durationSec) {
  const note = kind === 'audio'
    ? formatAudioTooLongNote(durationSec)
    : formatVideoTooLongNote(durationSec);
  return {
    tag,
    contentParts: [],
    textFragment: `${tag}${note} `,
    overDurationLimit: kind,
    durationNote: note.trim(),
  };
}

async function ingressSyncedAttachment(opts) {
  const {
    syncedPath,
    name,
    contentType = '',
    fetchBuffer,
    historyStorageId,
    metadataDurationSec = 0,
    getVoiceTranscription = null,
  } = opts;

  const tag = buildAttachmentTag(syncedPath, name);
  const kind = classifyAttachment(name, contentType);
  const contentParts = [];
  let textFragment = tag;

  if (kind.isImage) {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        contentParts.push(mediaToContentPart(buffer, contentType, {
          historyPath: syncedPath,
          historyUserId: historyStorageId,
        }));
      }
    } catch { /* tag only */ }
    return { tag, contentParts, textFragment: `${tag} ` };
  }

  if (kind.isAudio) {
    if (typeof getVoiceTranscription === 'function') {
      const tx = await getVoiceTranscription();
      if (tx) {
        return {
          tag,
          contentParts: [],
          textFragment: `${tag} <Transcription>${tx}</Transcription> `,
        };
      }
    }
    let audioDuration = metadataDurationSec;
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        audioDuration = await resolveMediaDurationSec({
          metadataSec: metadataDurationSec,
          buffer,
          extHint: kind.ext,
        });
        if (isAudioOverDurationLimit(audioDuration)) {
          return _durationSkipResult(tag, 'audio', audioDuration);
        }
        contentParts.push(mediaToContentPart(buffer, contentType, {
          historyPath: syncedPath,
          historyUserId: historyStorageId,
        }));
      }
    } catch { /* tag only */ }
    return { tag, contentParts, textFragment: `${tag} ` };
  }

  if (kind.isVideo) {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        const dur = await resolveMediaDurationSec({
          metadataSec: metadataDurationSec,
          buffer,
          extHint: kind.ext,
        });
        if (isVideoOverDurationLimit(dur)) {
          return _durationSkipResult(tag, 'video', dur);
        }
        contentParts.push(mediaToContentPart(buffer, contentType, {
          historyPath: syncedPath,
          historyUserId: historyStorageId,
        }));
      }
    } catch { /* tag only */ }
    return { tag, contentParts, textFragment: `${tag} ` };
  }

  if (kind.isPdf) {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        contentParts.push(mediaToContentPart(buffer, contentType || 'application/pdf', {
          historyPath: syncedPath,
          historyUserId: historyStorageId,
        }));
      }
    } catch { /* tag only */ }
    return { tag, contentParts, textFragment: `${tag} ` };
  }

  if (isInlineableTextFile(name, contentType)) {
    try {
      const buffer = await fetchBuffer();
      if (buffer) {
        const inline = buildInlineTextFilePart(syncedPath || name, buffer);
        return { tag, contentParts: [], textFragment: `${inline} ` };
      }
    } catch { /* tag only */ }
  }

  if (kind.isDoc && !kind.isPdf) {
    return { tag, contentParts: [], textFragment: `${tag} ` };
  }

  // Fallback: try native part for other binary types
  try {
    const buffer = await fetchBuffer();
    if (buffer) {
      contentParts.push(mediaToContentPart(buffer, contentType, {
        historyPath: syncedPath,
        historyUserId: historyStorageId,
      }));
    }
  } catch { /* tag only */ }
  return { tag, contentParts, textFragment: `${tag} ` };
}

module.exports = {
  createMemoizedFetchBuffer,
  ingressWaMessageMedia,
  classifyAttachment,
  ingressSyncedAttachment,
};