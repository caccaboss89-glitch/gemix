// src/ai/openaiResponsesTransport.js
//
// HTTP transport for the ChatGPT Codex Responses backend.
//
// Separate from apiClient.js on purpose: that stack is xAI-only and must never
// touch this path. Nothing here sends `x-grok-conv-id`, `max_turns`,
// `prompt_cache_key` or the xAI stale-URL retry, and no xAI credential is
// reachable from it.
//
// Auth: Hermes `openai-codex` pool, sent as `Authorization: Bearer …` plus
// `ChatGPT-Account-ID`. On a 401 (or a token already too close to expiry) the
// deployment's existing recovery runs once — one Hermes wake, cache
// invalidation, one retry — and never more.
//
// Budget: every call carries an absolute deadline and one AbortSignal shared by
// the request, the stream and the sleeps. A retry is only automatic before the
// first meaningful byte; once a delta or an item has arrived, a truncated
// stream is a partial response, not something to replay.
//
// Logging: metadata only. No bearer, account id, base64, encrypted_content,
// file content or user text is ever written.

import envConfig from '../config/env.js';
import {
  createOpenAiOAuthState,
  fetchWithOpenAiOAuth,
  isOpenAiOAuthError,
  resolveOpenAiOAuth
} from '../utils/openaiOAuth.js';
import { createLogger } from '../utils/logger.js';
import { joinUrl, SseDecoder, ResponseAssembler } from './openaiResponsesProtocol.js';

const log = createLogger('OpenAI');

/** Typed error categories used by the error policy, notifications and retries. */
const OPENAI_ERROR = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  SUBSCRIPTION_LIMIT: 'SUBSCRIPTION_LIMIT',
  TRANSIENT: 'TRANSIENT',
  TIMEOUT: 'TIMEOUT',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  UNSUPPORTED_INPUT: 'UNSUPPORTED_INPUT'
};

/** Attempts for a request that failed before producing anything meaningful. */
const MAX_COLD_ATTEMPTS = 3;
/** A token with less than this left is refreshed before the call, not after a 401. */
const MIN_TOKEN_REMAINING_MS = 2 * 60 * 1000;

/**
 * @param {string} kind - one of OPENAI_ERROR
 * @param {string} message - safe for logs: never contains a credential or user content
 * @param {object} [extra]
 */
function makeOpenAiError(kind, message, extra = {}) {
  const err = new Error(message);
  err.provider = 'openai';
  err.kind = kind;
  Object.assign(err, extra);
  return err;
}

/** Categorize an HTTP status plus its (already truncated) body. */
function classifyHttpFailure(status, bodyText) {
  if (status === 401) return OPENAI_ERROR.AUTH;
  if (status === 403) {
    return /quota|billing|plan|subscription/i.test(bodyText)
      ? OPENAI_ERROR.SUBSCRIPTION_LIMIT
      : OPENAI_ERROR.AUTH;
  }
  if (status === 429) {
    return /insufficient_quota|billing/i.test(bodyText)
      ? OPENAI_ERROR.SUBSCRIPTION_LIMIT
      : OPENAI_ERROR.RATE_LIMIT;
  }
  if (status === 400 || status === 415 || status === 422) return OPENAI_ERROR.UNSUPPORTED_INPUT;
  if (status >= 500) return OPENAI_ERROR.TRANSIENT;
  return OPENAI_ERROR.MALFORMED_RESPONSE;
}

/** Short, non-sensitive summary of an error body for logs. */
function summarizeErrorBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return '';
  if (bodyText.startsWith('<!')) return 'html error page';
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message || parsed?.detail;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch { /* fall through to the raw slice */ }
  return bodyText.slice(0, 300);
}

/**
 * Retry-After in milliseconds. Accepts delta-seconds and HTTP dates; never
 * returns more than what is left of the turn budget.
 * @param {Headers} headers
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
  return Math.min(waitMs, Math.max(0, remainingMs));
}

/** Abortable sleep that resolves early when the turn is cancelled. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * One turn's budget: an absolute deadline plus the AbortSignal every call,
 * stream, sleep and sub-operation of that turn shares.
 */
class TurnBudget {
  /**
   * @param {number} totalMs
   * @param {AbortSignal} [parentSignal] - aborting it aborts this budget too
   */
  constructor(totalMs, parentSignal) {
    this.deadlineAt = Date.now() + totalMs;
    this._controller = new AbortController();
    this._timer = setTimeout(() => this._controller.abort(), totalMs);
    this._timer.unref?.();
    if (parentSignal) {
      if (parentSignal.aborted) this._controller.abort();
      else parentSignal.addEventListener('abort', () => this._controller.abort(), { once: true });
    }
  }

  get signal() {
    return this._controller.signal;
  }

  get remainingMs() {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  /** True when there is no budget left to start new work. */
  get expired() {
    return this.remainingMs <= 0 || this._controller.signal.aborted;
  }

  /** Release the timer once the turn is over. */
  dispose() {
    clearTimeout(this._timer);
  }
}

/** Compatibility export for callers that only need the canonical credential. */
function resolveAuth(minRemainingMs) {
  return resolveOpenAiOAuth({ minRemainingMs });
}

/**
 * POST a Codex Responses request and consume its SSE stream.
 *
 * @param {object} opts
 * @param {object} opts.body - from buildResponsesBody
 * @param {TurnBudget} opts.budget
 * @param {string} [opts.requestId] - GemiX request id, for log correlation only
 * @returns {Promise<{ response: object, requestId: string|null, usage: object|null }>}
 */
async function callCodexResponses({ body, budget, requestId = null }) {
  const url = joinUrl(envConfig.OPENAI_BASE_URL, 'responses');
  const oauthState = createOpenAiOAuthState();

  for (let attempt = 1; attempt <= MAX_COLD_ATTEMPTS; attempt++) {
    if (budget.expired) {
      throw makeOpenAiError(OPENAI_ERROR.TIMEOUT, 'Turn budget exhausted before the request could start.');
    }
    const startedAt = Date.now();
    let res;
    let oauthResult;
    try {
      oauthResult = await fetchWithOpenAiOAuth(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: budget.signal
      }, {
        minRemainingMs: MIN_TOKEN_REMAINING_MS,
        refreshState: oauthState
      });
      res = oauthResult.response;
    } catch (err) {
      if (isOpenAiOAuthError(err)) {
        throw makeOpenAiError(OPENAI_ERROR.AUTH, err.message);
      }
      if (budget.signal.aborted) {
        throw makeOpenAiError(OPENAI_ERROR.TIMEOUT, 'Turn budget expired while contacting the model.');
      }
      // Nothing was received, so replaying is safe.
      if (attempt < MAX_COLD_ATTEMPTS) {
        log.warn(`request attempt ${attempt} failed before any response: ${err.message}`);
        await sleep(Math.min(attempt * 2000, budget.remainingMs), budget.signal);
        continue;
      }
      throw makeOpenAiError(OPENAI_ERROR.TRANSIENT, `Model unreachable after ${attempt} attempt(s): ${err.message}`);
    }

    const upstreamRequestId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || null;

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const kind = classifyHttpFailure(res.status, bodyText);
      const detail = summarizeErrorBody(bodyText);
      log.warn(`HTTP ${res.status} (${kind}) requestId=${upstreamRequestId ?? 'n/a'} gemixRequestId=${requestId ?? 'n/a'} — ${detail}`);
      if (oauthResult.refreshError) {
        log.error(`Hermes refresh failed: ${oauthResult.refreshError.message}`);
      }

      const retryable = kind === OPENAI_ERROR.TRANSIENT || kind === OPENAI_ERROR.RATE_LIMIT;
      if (retryable && attempt < MAX_COLD_ATTEMPTS) {
        const explicit = retryAfterMs(res.headers, budget.remainingMs);
        const waitMs = explicit === null ? Math.min(attempt * 2000, budget.remainingMs) : explicit;
        if (waitMs < budget.remainingMs) {
          await sleep(waitMs, budget.signal);
          continue;
        }
      }
      throw makeOpenAiError(kind, `Model request failed (HTTP ${res.status}): ${detail}`, {
        status: res.status,
        requestId: upstreamRequestId
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (!/text\/event-stream/i.test(contentType)) {
      const bodyText = await res.text().catch(() => '');
      throw makeOpenAiError(
        OPENAI_ERROR.MALFORMED_RESPONSE,
        `Expected an event stream, got "${contentType || 'no content-type'}": ${summarizeErrorBody(bodyText)}`,
        { requestId: upstreamRequestId }
      );
    }

    let assembled;
    try {
      assembled = await _consumeStream(res, budget, upstreamRequestId);
    } catch (err) {
      // A stream that produced nothing can be replayed: no tool ran, no partial
      // reply exists. Anything else — including a truncated stream that already
      // carried items — is reported as it is.
      if (err.kind === OPENAI_ERROR.TRANSIENT && !err.partial && attempt < MAX_COLD_ATTEMPTS) {
        log.warn(`stream attempt ${attempt} produced nothing: ${err.message}`);
        await sleep(Math.min(attempt * 2000, budget.remainingMs), budget.signal);
        continue;
      }
      throw err;
    }

    log.info(
      `model=${body.model} effort=${body.reasoning?.effort} status=${assembled.response.status ?? 'unknown'} `
      + `items=${assembled.response.output.length} durationMs=${Date.now() - startedAt} `
      + `attempt=${attempt} requestId=${upstreamRequestId ?? 'n/a'}`
      + (assembled.response.usage ? ` tokens=${assembled.response.usage.total_tokens ?? '?'}` : '')
    );

    return assembled;
  }

  throw makeOpenAiError(OPENAI_ERROR.TRANSIENT, 'Model request failed: retry budget exhausted.');
}

/**
 * Read the SSE body into a normalized response.
 * A stream that dies after producing content is a partial response and is never
 * retried automatically: the model may already have run a tool.
 */
async function _consumeStream(res, budget, upstreamRequestId) {
  const decoder = new SseDecoder();
  const assembler = new ResponseAssembler();

  try {
    for await (const chunk of res.body) {
      for (const event of decoder.push(chunk)) assembler.apply(event);
      if (budget.expired) {
        throw makeOpenAiError(OPENAI_ERROR.TIMEOUT, 'Turn budget expired while reading the model stream.', {
          partial: assembler.sawMeaningfulEvent
        });
      }
    }
    for (const event of decoder.end()) assembler.apply(event);
  } catch (err) {
    if (err.provider === 'openai') throw err;
    throw makeOpenAiError(
      assembler.sawMeaningfulEvent ? OPENAI_ERROR.MALFORMED_RESPONSE : OPENAI_ERROR.TRANSIENT,
      `Model stream ended early: ${err.message}`,
      { partial: assembler.sawMeaningfulEvent, requestId: upstreamRequestId }
    );
  }

  if (assembler.error) {
    const message = assembler.error.message || JSON.stringify(assembler.error).slice(0, 300);
    throw makeOpenAiError(OPENAI_ERROR.MALFORMED_RESPONSE, `Model reported an error: ${message}`, {
      requestId: upstreamRequestId
    });
  }
  if (assembler.status === 'failed') {
    throw makeOpenAiError(OPENAI_ERROR.MALFORMED_RESPONSE, 'Model reported a failed response.', {
      requestId: upstreamRequestId
    });
  }
  if (!assembler.status) {
    // EOF without response.completed: usable only if items already arrived.
    if (!assembler.sawMeaningfulEvent) {
      throw makeOpenAiError(OPENAI_ERROR.TRANSIENT, 'Model stream closed before sending anything.', {
        partial: false,
        requestId: upstreamRequestId
      });
    }
    log.warn(`stream closed without a terminal event; using ${assembler.toResponse().output.length} item(s) received`);
  }

  return {
    response: assembler.toResponse(),
    requestId: upstreamRequestId,
    usage: assembler.usage
  };
}

export {
  OPENAI_ERROR,
  TurnBudget,
  callCodexResponses,
  makeOpenAiError,
  classifyHttpFailure,
  retryAfterMs,
  resolveAuth,
  summarizeErrorBody
};
