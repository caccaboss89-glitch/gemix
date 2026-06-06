// Shared MIME → file-extension map (no leading dot). Used for ingress filenames
// and tunnel URL registration (see utils/aiFileDelivery.js).

/** @type {Record<string, string>} */
const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/tif': 'tif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/octet-stream': 'bin',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function mimeBase(mime) {
  if (!mime || typeof mime !== 'string') return '';
  return mime.split(';')[0].trim().toLowerCase();
}

/**
 * @param {string} mime
 * @param {string} [fallback] - without leading dot
 * @returns {string}
 */
function extensionForMime(mime, fallback = '') {
  const base = mimeBase(mime);
  return MIME_EXTENSION_MAP[base] || fallback;
}

/** Extension with leading dot for synthesized filenames. */
function dottedExtensionForMime(mime, fallback = '') {
  const ext = extensionForMime(mime, fallback);
  return ext ? `.${ext}` : '';
}

/** Prefer these MIME types when several map to the same extension (build + tunnel). */
const EXT_TO_MIME_PREFER = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.opus': 'audio/opus',
  '.tif': 'image/tiff',
};

/** Extensions absent from MIME_EXTENSION_MAP or with tunnel-specific MIME. */
const EXT_TO_MIME_ALIASES = {
  '.svg': 'image/svg+xml',
  '.oga': 'audio/ogg',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.htm': 'text/html',
};

function _buildExtToMimeMap() {
  const map = {};
  for (const [mime, ext] of Object.entries(MIME_EXTENSION_MAP)) {
    const key = `.${ext}`;
    if (!map[key]) map[key] = mime;
  }
  for (const [ext, mime] of Object.entries(EXT_TO_MIME_PREFER)) {
    map[ext] = mime;
  }
  for (const [ext, mime] of Object.entries(EXT_TO_MIME_ALIASES)) {
    map[ext] = mime;
  }
  if (map['.jpg'] && !map['.jpeg']) map['.jpeg'] = map['.jpg'];
  return map;
}

const EXT_TO_MIME_MAP = _buildExtToMimeMap();

/**
 * @param {string} ext - with or without leading dot
 * @param {string} [fallback]
 * @returns {string}
 */
function mimeForExtension(ext, fallback = 'application/octet-stream', contentTypeHint = '') {
  if (!ext || typeof ext !== 'string') return fallback;
  const key = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  if (key === '.webm' && contentTypeHint) {
    const ct = mimeBase(contentTypeHint);
    if (ct === 'audio/webm' || (ct.startsWith('audio/') && ct !== 'video/webm')) return 'audio/webm';
    if (ct.startsWith('video/')) return 'video/webm';
  }
  return EXT_TO_MIME_MAP[key] || fallback;
}

module.exports = {
  MIME_EXTENSION_MAP,
  mimeBase,
  extensionForMime,
  dottedExtensionForMime,
  mimeForExtension,
};