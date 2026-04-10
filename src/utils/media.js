const { SUPPORTED_MEDIA, UNSUPPORTED_MEDIA, MAX_DOC_PAGES } = require('../config/constants');
const pdfParse = require('pdf-parse');

/**
 * Check if a media type is supported by the AI.
 * @param {string} type - Media type (e.g., 'image', 'audio')
 * @returns {boolean} True if media type is supported
 */
function isSupportedMedia(type) {
  return SUPPORTED_MEDIA.includes(type);
}

/**
 * Check if a media type is explicitly unsupported.
 * @param {string} type - Media type (e.g., 'video')
 * @returns {boolean} True if media type is unsupported
 */
function isUnsupportedMedia(type) {
  return UNSUPPORTED_MEDIA.includes(type);
}

/**
 * Extract text transcription from a PDF document content part (base64).
 * Used to convert binary PDFs to text before sending to AI provider.
 * @param {object} contentPart - Content part with type='image_url' containing PDF base64
 * @returns {Promise<{success: boolean, text?: string, error?: string}>} Transcription result
 */
async function transcribeDocumentFromContentPart(contentPart) {
  try {
    if (!contentPart || !contentPart.image_url || !contentPart.image_url.url) {
      return { success: false, error: 'Invalid content part structure' };
    }

    const dataUrl = contentPart.image_url.url;
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      return { success: false, error: 'Invalid base64 data URI format' };
    }

    const mimetype = match[1].toLowerCase();
    const base64Data = match[2];

    // Only transcribe PDFs for now
    if (mimetype !== 'application/pdf') {
      return { success: false, error: `Unsupported document type: ${mimetype}` };
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const info = await pdfParse(buffer);

    if (!info || !info.text) {
      return { success: false, error: 'PDF parse returned no text' };
    }

    if (info.numpages > MAX_DOC_PAGES) {
      return {
        success: true,
        text: `[Documento troppo lungo per essere trascritto: ${info.numpages} pagine (max ${MAX_DOC_PAGES})]`,
      };
    }

    return {
      success: true,
      text: info.text.trim(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Convert media to base64 content part for the AI API (OpenAI-compatible format).
 * All media types use image_url with data URI — the MIME type tells the model the actual content type.
 * @param {Buffer} buffer
 * @param {string} mimetype - e.g. 'image/jpeg', 'audio/ogg', 'application/pdf'
 * @returns {object} Content part for the messages array
 */
function mediaToContentPart(buffer, mimetype) {
  // Strip parameters (e.g. 'audio/ogg; codecs=opus' → 'audio/ogg')
  const cleanMime = mimetype.split(';')[0].trim();
  const base64 = buffer.toString('base64');
  return {
    type: 'image_url',
    image_url: { url: `data:${cleanMime};base64,${base64}` },
  };
}

/**
 * Build a filename descriptor for unsupported or any media in history
 */
function mediaTag(filename, mimetype) {
  if (filename) return `[${filename}]`;
  const ext = (mimetype || '').split('/')[1] || 'file';
  return `[file.${ext}]`;
}

/**
 * Transcribe all documents in a message content array.
 * Replaces PDF content parts with text transcriptions.
 * Used to ensure documents are always transcribed before sending to AI.
 * @param {Array|string} content - Message content (can be string or array of parts)
 * @returns {Promise<Array|string>} Transcribed content
 */
async function transcribeDocumentsInMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content;
  }

  const transcribed = [];

  for (const part of content) {
    if (!part) {
      transcribed.push(part);
      continue;
    }

    // Check if this is a document content part
    if (_getMediaTypeFromContentPart(part) === 'document') {
      const result = await transcribeDocumentFromContentPart(part);
      if (result.success && result.text) {
        // Replace document with text containing transcription
        transcribed.push({
          type: 'text',
          text: `<Trascrizione>\n${result.text}\n</Trascrizione>`,
        });
      } else {
        // If transcription fails, keep original and add error note
        transcribed.push(part);
        if (result.error) {
          transcribed.push({
            type: 'text',
            text: `⚠️ Errore trascrizione documento: ${result.error}`,
          });
        }
      }
    } else {
      // Keep non-document parts as-is
      transcribed.push(part);
    }
  }

  return transcribed;
}

function _getMediaTypeFromContentPart(part) {
  if (!part || !part.image_url || !part.image_url.url) return null;
  const m = /^data:([^;]+);base64,/.exec(part.image_url.url);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('application/')) return 'document';
  return null;
}

function hasHistoryImages(historyMessages) {
  if (!Array.isArray(historyMessages)) return false;

  for (const message of historyMessages) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (_getMediaTypeFromContentPart(part) === 'image') return true;
    }
  }

  return false;
}

function hasHistoryDocs(historyMessages) {
  if (!Array.isArray(historyMessages)) return false;

  const docTagRegex = /\[([^\]]+\.(?:pdf|txt|doc|docx|csv|json))\]/i;
  const supportedDocExts = new Set(['pdf', 'txt', 'doc', 'docx', 'csv', 'json']);

  for (const message of historyMessages) {
    if (!message) continue;

    if (typeof message.content === 'string') {
      if (docTagRegex.test(message.content)) return true;
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (_getMediaTypeFromContentPart(part) === 'document') return true;
        if (part && part.type === 'text') {
          const match = docTagRegex.exec(part.text);
          if (match) {
            const ext = (match[1] || '').toLowerCase();
            if (supportedDocExts.has(ext)) return true;
          }
        }
      }
    }
  }

  return false;
}

function extractLastNImages(historyMessages, count = 0) {
  if (!Array.isArray(historyMessages) || count <= 0) return [];

  const imageParts = [];

  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const message = historyMessages[i];
    if (!message || !Array.isArray(message.content)) continue;

    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j];
      if (_getMediaTypeFromContentPart(part) === 'image') {
        imageParts.push(part);
        if (imageParts.length >= count) break;
      }
    }

    if (imageParts.length >= count) break;
  }

  return imageParts.reverse();
}

function extractLastNDocs(historyMessages, count = 0) {
  if (!Array.isArray(historyMessages) || count <= 0) return [];

  const docParts = [];

  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const message = historyMessages[i];
    if (!message || !Array.isArray(message.content)) continue;

    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j];
      if (_getMediaTypeFromContentPart(part) === 'document') {
        docParts.push(part);
        if (docParts.length >= count) break;
      }
    }

    if (docParts.length >= count) break;
  }

  return docParts.reverse();
}

function hasHistoryVoices(historyMessages) {
  if (!Array.isArray(historyMessages)) return false;

  for (const message of historyMessages) {
    if (!message || message.role === 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (_getMediaTypeFromContentPart(part) === 'audio') return true;
    }
  }

  return false;
}

function extractLastNVoices(historyMessages, count = 0) {
  if (!Array.isArray(historyMessages) || count <= 0) return [];

  const audioParts = [];

  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const message = historyMessages[i];
    if (!message || message.role === 'assistant' || !Array.isArray(message.content)) continue;

    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j];
      if (_getMediaTypeFromContentPart(part) === 'audio') {
        audioParts.push(part);
        if (audioParts.length >= count) break;
      }
    }

    if (audioParts.length >= count) break;
  }

  return audioParts.reverse();
}

function limitHistoryMediaAttachments(historyMessages, maxImages = 3, maxAudios = 1, maxDocs = 0) {
  if (!Array.isArray(historyMessages)) return historyMessages;

  const remain = {
    image: maxImages,
    audio: maxAudios,
    document: maxDocs,
  };

  // We iterate from newest to oldest to retain the latest attachments.
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const message = historyMessages[i];
    if (!message || !Array.isArray(message.content)) continue;

    const parts = message.content;
    const keepFlags = new Array(parts.length).fill(false);

    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j];
      if (!part || part.type === 'text') {
        keepFlags[j] = true;
        continue;
      }

      const mediaType = _getMediaTypeFromContentPart(part);
      if (mediaType === 'image' || mediaType === 'audio' || mediaType === 'document') {
        if (remain[mediaType] > 0) {
          keepFlags[j] = true;
          remain[mediaType] -= 1;
        } else {
          keepFlags[j] = false;
        }
      } else {
        // Keep other media types (video/etc.) unchanged.
        keepFlags[j] = true;
      }
    }

    const filtered = parts.filter((_, idx) => keepFlags[idx]);
    if (filtered.length === 0) {
      historyMessages.splice(i, 1);
    } else if (filtered.length === 1 && filtered[0].type === 'text') {
      historyMessages[i].content = filtered[0].text;
    } else {
      historyMessages[i].content = filtered;
    }
  }

  return historyMessages;
}

module.exports = {
  isSupportedMedia,
  isUnsupportedMedia,
  mediaToContentPart,
  mediaTag,
  transcribeDocumentFromContentPart,
  transcribeDocumentsInMessageContent,
  hasHistoryImages,
  hasHistoryDocs,
  hasHistoryVoices,
  extractLastNImages,
  extractLastNDocs,
  extractLastNVoices,
  limitHistoryMediaAttachments,
};
