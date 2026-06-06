// Public HTTPS base for temp attachment URLs (xAI input_file, WhatsApp download links).
// Set GEMIX_PUBLIC_ATTACHMENT_BASE_URL in .env (no trailing slash).

const { createLogger } = require('./logger');
const env = require('../config/env');

const log = createLogger('PublicAttachmentUrl');

const LOCAL_FALLBACK = 'http://localhost:9998';
let _missingWarned = false;

function getPublicBaseUrl() {
  const raw = env.GEMIX_PUBLIC_ATTACHMENT_BASE_URL;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const normalized = raw.trim().replace(/\/+$/, '');
      new URL(normalized);
      return normalized;
    } catch (err) {
      log.error(`Invalid GEMIX_PUBLIC_ATTACHMENT_BASE_URL: ${err.message}`);
    }
  }
  if (!_missingWarned) {
    _missingWarned = true;
    log.warn(
      'GEMIX_PUBLIC_ATTACHMENT_BASE_URL not set — attachment links use http://localhost:9998 (xAI cannot fetch)',
    );
  }
  return LOCAL_FALLBACK;
}

module.exports = { getPublicBaseUrl };