// Shared MIME → extension map for WA/Discord ingress and history sync.

const path = require('path');

const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/tiff': '.tiff',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/webm': '.webm',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/aac': '.aac',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt', 'text/markdown': '.md', 'text/html': '.html', 'text/csv': '.csv',
  'application/json': '.json',
};

function resolveIngressFilename(givenName, mimetype, msgId = null) {
  if (givenName && path.extname(givenName)) return givenName;
  const baseMime = (mimetype || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[baseMime] || '';
  const shortId = msgId ? String(msgId).slice(-8) : Date.now().toString(36);
  const base = givenName || `file_${shortId}`;
  return ext ? `${base}${ext}` : base;
}

module.exports = { MIME_TO_EXT, resolveIngressFilename };