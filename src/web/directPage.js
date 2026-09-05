// Safe last-resort page extraction owned by GemiX. The public HTTP boundary
// validates and pins DNS across redirects; Kreuzberg turns the downloaded
// bytes into text without executing the page.

import { downloadPublicFile } from '../utils/fetch.js';
import { createLogger } from '../utils/logger.js';
import constants from '../config/constants.js';
import { runKreuzbergOperation } from '../parsers/kreuzbergProcess.js';

const log = createLogger('DirectPage');
const MAX_DIRECT_PAGE_BYTES = 10 * 1024 * 1024;
const DIRECT_PAGE_TIMEOUT_MS = 25_000;

/** True when Google Cache returned its own consent/search UI, not the target. */
function isGoogleInterstice(content, strategy) {
  if (typeof strategy !== 'string' || !/cache/i.test(strategy) || typeof content !== 'string') return false;
  return /(?:before you continue to google|prima di continuare su google|consent\.google|google uses cookies)/i.test(content)
    || (/cache:https?:\/\//i.test(content) && /(?:cerca con google|search with google)/i.test(content))
    || (/cache:https?:\/\//i.test(content)
      && /(?:non ha prodotto risultati in nessun documento|did not match any documents|no results found)/i.test(content));
}

async function readPublicPageDirect(url, maxChars, signal) {
  const cap = Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : constants.READ_PAGE_MAX_CHARS;
  try {
    signal?.throwIfAborted();
    const downloaded = await downloadPublicFile(url, {
      maxBytes: MAX_DIRECT_PAGE_BYTES,
      timeoutMs: DIRECT_PAGE_TIMEOUT_MS,
      signal
    });
    signal?.throwIfAborted();
    const extracted = await runKreuzbergOperation('extractBytes', {
      buffer: downloaded.buffer,
      mime: downloaded.mimetype || 'application/octet-stream'
    }, { signal, timeoutMs: DIRECT_PAGE_TIMEOUT_MS });
    signal?.throwIfAborted();
    const content = typeof extracted?.content === 'string' ? extracted.content.trim() : '';
    if (!content) return { ok: false, error: 'Direct extraction returned no readable text.' };
    return {
      ok: true,
      content: content.slice(0, cap),
      strategy: 'direct-kreuzberg',
      chars: Math.min(content.length, cap),
      trustTier: 'unknown'
    };
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    log.warn(`Direct extraction failed for ${String(url).slice(0, 160)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export { isGoogleInterstice, readPublicPageDirect };
