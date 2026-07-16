// Transient Puppeteer / whatsapp-web.js evaluate failures.
// WhatsApp Web often minifies thrown errors to "r: r" when the page context
// is destroyed or mid-reload (see wwebjs issues on getChatById after WA updates).

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isWaPuppeteerTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || err || '').trim();
  const stack = String(err.stack || '');
  const blob = `${msg}\n${stack}`.toLowerCase();

  // Minified WA Web / Puppeteer payload seen in production: message "r", stack "r: r"
  if (/^r$/i.test(msg) || /^r:\s*r$/i.test(msg)) return true;

  if (blob.includes('execution context was destroyed')) return true;
  if (blob.includes('cannot find context with specified id')) return true;
  if (blob.includes('target closed')) return true;
  if (blob.includes('session closed')) return true;
  if (blob.includes('protocol error')) return true;
  if (blob.includes('navigating frame was detached')) return true;
  if (blob.includes('frame was detached')) return true;
  if (blob.includes('most likely because of a navigation')) return true;

  // Puppeteer evaluate path in stack without a useful message
  if (
    (msg.length <= 3 || /^[a-z]$/i.test(msg))
    && (stack.includes('ExecutionContext') || stack.includes('evaluate'))
  ) {
    return true;
  }

  return false;
}

/**
 * Retry an async puppeteer-backed call a few times on transient failures.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=2]
 * @param {number} [opts.delayMs=400]
 * @returns {Promise<T>}
 */
async function withWaPuppeteerRetry(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries) || 2);
  const delayMs = Math.max(50, Number(opts.delayMs) || 400);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isWaPuppeteerTransientError(err) || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Format an error for logs (handles minified single-letter messages).
 * @param {unknown} err
 * @returns {string}
 */
function formatWaError(err) {
  if (!err) return '(unknown error)';
  const msg = String(err.message || err).trim() || '(empty message)';
  const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
  if (isWaPuppeteerTransientError(err)) {
    return `${name}${msg} [puppeteer/WA Web transient]`;
  }
  return `${name}${msg}`;
}

module.exports = {
  isWaPuppeteerTransientError,
  withWaPuppeteerRetry,
  formatWaError,
};
