// Public HTTPS base for the temp attachment links GemiX sends to users on
// WhatsApp and Discord. The model never receives one: its files come by path.
// Set GEMIX_PUBLIC_ATTACHMENT_BASE_URL in .env (no trailing slash).

import { createLogger  } from './logger.js';
import env from '../config/env.js';

const log = createLogger('PublicAttachmentUrl');

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
  const localFallback = `http://localhost:${env.GEMIX_TEMP_FILE_PORT}`;
  if (!_missingWarned) {
    _missingWarned = true;
    log.warn(
      `GEMIX_PUBLIC_ATTACHMENT_BASE_URL not set — attachment links use ${localFallback} (not reachable from outside)`
    );
  }
  return localFallback;
}

export { getPublicBaseUrl };
