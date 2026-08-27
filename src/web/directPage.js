// Safe last-resort page extraction owned by GemiX. The public HTTP boundary
// validates and pins DNS across redirects; Kreuzberg turns the downloaded
// bytes into text without executing the page.

import { downloadPublicFile } from '../utils/fetch.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DirectPage');
const MAX_DIRECT_PAGE_BYTES = 10 * 1024 * 1024;
const DIRECT_PAGE_TIMEOUT_MS = 25_000;

let _extractBytes = null;

async function _extract(buffer, mimetype) {
  if (!_extractBytes) ({ extractBytes: _extractBytes } = await import('@kreuzberg/node'));
  return _extractBytes(buffer, mimetype || 'application/octet-stream');
}

/** True when Google Cache returned its own consent/search UI, not the target. */
function isGoogleInterstice(content, strategy) {
  if (strategy !== 'google-cache' || typeof content !== 'string') return false;
  return /(?:before you continue to google|prima di continuare su google|consent\.google|google uses cookies)/i.test(content)
    || (/^cache:https?:\/\//i.test(content.trim()) && /(?:cerca con google|search with google)/i.test(content));
}

async function readPublicPageDirect(url, maxChars, signal) {
  try {
    const downloaded = await downloadPublicFile(url, {
      maxBytes: MAX_DIRECT_PAGE_BYTES,
      timeoutMs: DIRECT_PAGE_TIMEOUT_MS,
      signal
    });
    const extracted = await _extract(downloaded.buffer, downloaded.mimetype);
    const content = typeof extracted?.content === 'string' ? extracted.content.trim() : '';
    if (!content) return { ok: false, error: 'Direct extraction returned no readable text.' };
    return {
      ok: true,
      content: content.slice(0, maxChars),
      strategy: 'direct-kreuzberg',
      chars: Math.min(content.length, maxChars),
      trustTier: 'unknown'
    };
  } catch (err) {
    log.warn(`Direct extraction failed for ${String(url).slice(0, 160)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export { isGoogleInterstice, readPublicPageDirect };
