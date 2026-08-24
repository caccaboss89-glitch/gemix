// Shared MIME → extension map for WA/Discord ingress and history sync.

import path from 'path';
import { dottedExtensionForMime  } from '../config/mimeExtensions.js';

function resolveIngressFilename(givenName, mimetype, msgId = null) {
  if (givenName && path.extname(givenName)) return givenName;
  const ext = dottedExtensionForMime(mimetype, '');
  const shortId = msgId ? String(msgId).slice(-8) : Date.now().toString(36);
  const base = givenName || `file_${shortId}`;
  return ext ? `${base}${ext}` : base;
}

export { resolveIngressFilename };
