// Shared MIME → extension map for WA/Discord ingress and history sync.

const path = require('path');
const { dottedExtensionForMime } = require('../config/mimeExtensions');

function resolveIngressFilename(givenName, mimetype, msgId = null) {
  if (givenName && path.extname(givenName)) return givenName;
  const ext = dottedExtensionForMime(mimetype, '');
  const shortId = msgId ? String(msgId).slice(-8) : Date.now().toString(36);
  const base = givenName || `file_${shortId}`;
  return ext ? `${base}${ext}` : base;
}

module.exports = { resolveIngressFilename };