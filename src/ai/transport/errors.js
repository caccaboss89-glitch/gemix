// src/ai/transport/errors.js
//
// Typed failures for the Responses transport. The taxonomy is provider-neutral:
// every profile classifies its HTTP failures into the same seven kinds so the
// retry policy, the user-facing message and the admin notification can be
// decided once, above the wire.
//
// Nothing here knows about xAI, ChatGPT or Cloudflare. A provider extension
// that recognizes one of its own bodies refines the kind through
// `classifyHttpFailure`'s `refine` hook, it does not invent a new one.

/** The only failure kinds a transport may report. */
const TRANSPORT_ERROR = Object.freeze({
  /** Credentials missing, rejected or unrecoverable after one refresh. */
  AUTH: 'AUTH',
  /** Throttled: the same request may work later. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** Allowance/credit spent: retrying now cannot help. */
  QUOTA: 'QUOTA',
  /** Network or 5xx: safe to replay when nothing was received. */
  TRANSIENT: 'TRANSIENT',
  /** Deadline hit (turn budget or request timeout). */
  TIMEOUT: 'TIMEOUT',
  /** The request body was refused (bad field, unsupported part, too large). */
  UNSUPPORTED_INPUT: 'UNSUPPORTED_INPUT',
  /** A 2xx answer GemiX cannot read, or a stream that reported an error. */
  MALFORMED: 'MALFORMED'
});

class TransportError extends Error {
  /**
   * @param {string} kind - one of TRANSPORT_ERROR
   * @param {string} message - safe for logs: never a credential or user content
   * @param {object} [extra] - { status, requestId, partial, retryAfterMs, providerId }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'TransportError';
    this.kind = TRANSPORT_ERROR[kind] ? kind : TRANSPORT_ERROR.MALFORMED;
    this.status = extra.status ?? null;
    this.requestId = extra.requestId ?? null;
    /** True when items already reached GemiX: replaying would duplicate work. */
    this.partial = extra.partial === true;
    this.retryAfterMs = Number.isFinite(extra.retryAfterMs) ? extra.retryAfterMs : null;
    this.providerId = extra.providerId ?? null;
  }
}

function isTransportError(err) {
  return err instanceof TransportError;
}

/**
 * Map an HTTP status plus its (already read) body to a transport kind.
 *
 * @param {number} status
 * @param {string} bodyText
 * @param {(status: number, bodyText: string) => string|null} [refine] - provider
 *   hook that may return a more specific kind for a body it recognizes.
 * @returns {string}
 */
function classifyHttpFailure(status, bodyText, refine = null) {
  const body = typeof bodyText === 'string' ? bodyText : '';
  if (typeof refine === 'function') {
    const refined = refine(status, body);
    if (refined && TRANSPORT_ERROR[refined]) return refined;
  }
  if (status === 401) return TRANSPORT_ERROR.AUTH;
  if (status === 403) {
    return /quota|billing|plan|subscription|spending-limit|credit/i.test(body)
      ? TRANSPORT_ERROR.QUOTA
      : TRANSPORT_ERROR.AUTH;
  }
  if (status === 429) {
    return /insufficient_quota|billing|spending-limit|credit/i.test(body)
      ? TRANSPORT_ERROR.QUOTA
      : TRANSPORT_ERROR.RATE_LIMIT;
  }
  if (status === 408 || status === 504) return TRANSPORT_ERROR.TIMEOUT;
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return TRANSPORT_ERROR.UNSUPPORTED_INPUT;
  }
  if (status >= 500) return TRANSPORT_ERROR.TRANSIENT;
  return TRANSPORT_ERROR.MALFORMED;
}

/**
 * Classify an error reported inside an otherwise successful Responses stream.
 * Providers do not use one exact shape here, so inspect the stable semantic
 * fields and message while keeping unknown protocol failures non-retryable.
 *
 * @param {object|string|null} error
 * @returns {string}
 */
function classifyStreamFailure(error) {
  if (Number.isInteger(error?.status)) {
    return classifyHttpFailure(error.status, JSON.stringify(error));
  }

  const details = typeof error === 'string'
    ? error
    : [error?.type, error?.code, error?.message]
      .filter(value => typeof value === 'string')
      .join(' ');

  if (/insufficient[_ -]?quota|billing|spending[_ -]?limit|credit/i.test(details)) {
    return TRANSPORT_ERROR.QUOTA;
  }
  if (/rate[_ -]?limit|too many requests|throttl/i.test(details)) {
    return TRANSPORT_ERROR.RATE_LIMIT;
  }
  if (/server[_ -]?error|internal[_ -]?(?:server[_ -]?)?error|overload|service[_ -]?unavailable|temporar(?:y|ily) unavailable|try again later/i.test(details)) {
    return TRANSPORT_ERROR.TRANSIENT;
  }
  if (/authentication|authorization|invalid[_ -]?(?:api[_ -]?)?key|unauthorized|forbidden/i.test(details)) {
    return TRANSPORT_ERROR.AUTH;
  }
  if (/invalid[_ -]?request|unsupported|unprocessable|context[_ -]?length/i.test(details)) {
    return TRANSPORT_ERROR.UNSUPPORTED_INPUT;
  }
  return TRANSPORT_ERROR.MALFORMED;
}

/** Short, credential-free summary of an error body, for logs and admin notices. */
function summarizeErrorBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return '';
  if (bodyText.startsWith('<!')) return 'html error page';
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message || parsed?.detail || parsed?.code;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch { /* fall through to the raw slice */ }
  return bodyText.slice(0, 300);
}

/**
 * `Retry-After` in milliseconds, clamped to what is left of the caller's budget.
 * Accepts delta-seconds and HTTP dates; null when the header is absent or unusable.
 *
 * @param {Headers|{get:Function}} headers
 * @param {number} remainingMs
 * @returns {number|null}
 */
function retryAfterMs(headers, remainingMs) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  let waitMs;
  if (Number.isFinite(seconds)) {
    waitMs = seconds * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    waitMs = at - Date.now();
  }
  if (!(waitMs > 0)) return 0;
  const budget = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : waitMs;
  return Math.min(waitMs, budget);
}

/** Kinds whose cause can clear on its own, so a cold replay is worth making. */
function isRetryableKind(kind) {
  return kind === TRANSPORT_ERROR.TRANSIENT || kind === TRANSPORT_ERROR.RATE_LIMIT;
}

export {
  TRANSPORT_ERROR,
  TransportError,
  isTransportError,
  classifyHttpFailure,
  classifyStreamFailure,
  summarizeErrorBody,
  retryAfterMs,
  isRetryableKind
};
