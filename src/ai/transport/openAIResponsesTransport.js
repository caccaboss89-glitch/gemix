// src/ai/transport/openAIResponsesTransport.js
//
// The one transport the GemiX main brain speaks: POST /responses with
// `stream:true`, consumed as SSE, for every profile.
//
// It is provider-agnostic on purpose. Everything a specific backend needs —
// extra headers, an extra body field, a body it alone can classify, the item
// types it accepts back on replay — arrives through the `extensions` object the
// profile composes. Nothing in this file names xAI, ChatGPT or OpenRouter, and
// nothing in it reads a token from disk: credentials come from the profile's
// CredentialProvider and go straight into an outbound header.
//
// Retry policy: cold only. Once a stream has produced a meaningful
// event the model may already have run a tool, so a truncated stream is a
// partial response to report, never something to replay. `Retry-After` is
// honoured and clamped to what is left of the turn.
//
// Every actual wire attempt writes the provider-neutral request, SSE events and
// assembled response. Credentials and opaque binary/encrypted payloads are
// redacted by the shared API logger before they reach disk.

import crypto from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import { TurnBudget, sleepWithin } from '../../utils/turnBudget.js';
import { logApiRequest, logApiResponse } from '../apiLogs.js';
import { consumeResponseStream } from './responseStreamReader.js';
import {
  TRANSPORT_ERROR,
  TransportError,
  classifyHttpFailure,
  isRetryableKind,
  retryAfterMs,
  summarizeErrorBody
} from './errors.js';

/** Attempts for a request that failed before producing anything meaningful. */
const MAX_COLD_ATTEMPTS = 3;
/** A credential with less than this left is refreshed before the call, not after a 401. */
const MIN_TOKEN_REMAINING_MS = 2 * 60 * 1000;
/** Default ceiling for one model call when the caller passes no budget. */
const DEFAULT_CALL_TIMEOUT_MS = 4 * 60 * 1000;

function _joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const tail = String(path || '').replace(/^\/+/, '');
  return tail ? `${base}/${tail}` : base;
}

function _responseHeaders(headers) {
  if (!headers?.entries) return {};
  return Object.fromEntries(headers.entries());
}

class OpenAIResponsesTransport {
  /**
   * @param {object} opts
   * @param {import('../credentials/credentialProvider.js').CredentialProvider} opts.credentialProvider
   * @param {string} [opts.baseUrl] - profile fallback when the credential has no account override
   * @param {object} [opts.extensions] - provider extension (see ai/extensions/)
   * @param {string} [opts.label] - short name for log lines
   * @param {Function} [opts.fetchImpl] - injected for tests
   * @param {object|null} [opts.apiLogWriter] - injected log sink; null disables test logging
   */
  constructor(opts = {}) {
    if (!opts.credentialProvider) {
      throw new Error('OpenAIResponsesTransport: a credentialProvider is required');
    }
    this.credentials = opts.credentialProvider;
    this.baseUrl = opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, '') : null;
    this.extensions = opts.extensions || null;
    this.label = opts.label || 'responses';
    this._fetch = opts.fetchImpl || ((...args) => fetch(...args));
    this._apiLogWriter = Object.hasOwn(opts, 'apiLogWriter')
      ? opts.apiLogWriter
      : (opts.fetchImpl ? null : { request: logApiRequest, response: logApiResponse });
    this._log = createLogger(`Transport:${this.label}`);
    /**
     * Whether the "no content-type" notice has already been given. Worth saying
     * once, because it tells you the endpoint omits a header the protocol asks
     * for; not worth repeating on every call, which would only teach the reader
     * to skip that line. It is info and not warn on purpose: nothing went
     * wrong, and warn goes to stderr, where a process manager paints it red.
     */
    this._notedMissingContentType = false;
  }

  /**
   * Send one Responses request and return the assembled response.
   *
   * @param {object} opts
   * @param {object} opts.body - from buildResponsesBody (stream/store already set)
   * @param {TurnBudget} [opts.budget] - the turn's deadline; one is created when absent
   * @param {string|null} [opts.requestId] - GemiX request id, for log correlation only
   * @param {object} [opts.context] - opaque data handed to the extension hooks
   * @returns {Promise<{ response: object, requestId: string|null, usage: object|null }>}
   */
  async createResponse({ body, budget = null, requestId = null, context = {} }) {
    const ownBudget = budget || new TurnBudget(DEFAULT_CALL_TIMEOUT_MS);
    try {
      return await this._attemptLoop({ body, budget: ownBudget, requestId, context });
    } finally {
      if (!budget) ownBudget.dispose();
    }
  }

  async _attemptLoop({ body, budget, requestId, context }) {
    let refreshedOnce = false;

    for (let attempt = 1; attempt <= MAX_COLD_ATTEMPTS; attempt++) {
      if (budget.expired) {
        throw this._error(TRANSPORT_ERROR.TIMEOUT, 'Turn budget exhausted before the request could start.');
      }

      let credential;
      try {
        credential = await this.credentials.get({ minRemainingMs: MIN_TOKEN_REMAINING_MS });
      } catch (err) {
        throw this._error(TRANSPORT_ERROR.AUTH, `No usable credential: ${err.message}`);
      }

      const url = _joinUrl(credential.baseUrl || this.baseUrl, 'responses');
      const wireBody = this.extensions?.decorateBody
        ? this.extensions.decorateBody({ ...body }, context)
        : body;
      const headers = this._buildHeaders(credential, context);

      const startedAt = Date.now();
      const apiLogId = crypto.randomUUID();
      const logMeta = {
        apiLogId,
        transport: 'responses',
        provider: this.extensions?.providerId || this.label,
        gemixRequestId: requestId,
        round: context.round ?? null,
        phase: context.phase ?? null,
        attempt
      };
      this._writeApiLog('request', wireBody.model, url, wireBody, {
        ...logMeta,
        startedAt: new Date(startedAt).toISOString()
      });
      let res;
      try {
        res = await this._fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(wireBody),
          signal: budget.signal
        });
      } catch (err) {
        this._writeApiLog('response', wireBody.model, url, {
          http: null,
          error: { name: err.name, message: err.message }
        }, {
          ...logMeta,
          durationMs: Date.now() - startedAt
        });
        if (budget.signal.aborted) {
          throw this._error(TRANSPORT_ERROR.TIMEOUT, 'Turn budget expired while contacting the model.');
        }
        // Nothing was received, so replaying is safe.
        if (attempt < MAX_COLD_ATTEMPTS) {
          this._log.warn(`attempt ${attempt} failed before any response: ${err.message}`);
          await sleepWithin(Math.min(attempt * 2000, budget.remainingMs), budget.signal);
          continue;
        }
        throw this._error(TRANSPORT_ERROR.TRANSIENT, `Model unreachable after ${attempt} attempt(s): ${err.message}`);
      }

      const upstreamRequestId = res.headers.get('x-request-id') || res.headers.get('cf-ray') || null;

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        this._writeApiLog('response', wireBody.model, url, {
          http: {
            status: res.status,
            headers: _responseHeaders(res.headers)
          },
          body: bodyText
        }, {
          ...logMeta,
          upstreamRequestId,
          durationMs: Date.now() - startedAt
        });
        const kind = classifyHttpFailure(res.status, bodyText, this.extensions?.refineHttpFailure);
        const detail = summarizeErrorBody(bodyText);
        this._log.warn(
          `HTTP ${res.status} (${kind}) requestId=${upstreamRequestId ?? 'n/a'} `
          + `gemixRequestId=${requestId ?? 'n/a'} — ${detail}`
        );

        // One credential refresh per request, then the failure stands.
        if (kind === TRANSPORT_ERROR.AUTH && !refreshedOnce) {
          refreshedOnce = true;
          await this.credentials.markStatus('auth_failed', credential.accountId);
          try {
            await this.credentials.refresh({
              accountId: credential.accountId,
              minRemainingMs: MIN_TOKEN_REMAINING_MS
            });
            // A successful refresh is not a failed attempt: give the budget back.
            attempt--;
            this._log.info('credential refreshed after an auth failure; retrying once');
            continue;
          } catch (refreshErr) {
            this._log.error(`credential refresh failed: ${refreshErr.message}`);
          }
        }

        if (kind === TRANSPORT_ERROR.QUOTA) {
          await this.credentials.markStatus('quota', credential.accountId);
        }

        const explicitWait = retryAfterMs(res.headers, budget.remainingMs);
        if (isRetryableKind(kind) && attempt < MAX_COLD_ATTEMPTS) {
          const waitMs = explicitWait === null ? Math.min(attempt * 2000, budget.remainingMs) : explicitWait;
          if (waitMs < budget.remainingMs) {
            await sleepWithin(waitMs, budget.signal);
            continue;
          }
        }
        throw this._error(kind, `Model request failed (HTTP ${res.status}): ${detail}`, {
          status: res.status,
          requestId: upstreamRequestId,
          retryAfterMs: explicitWait
        });
      }

      //  A *wrong* content-type and a *missing* one are not the same evidence,
      //  and they are handled differently on purpose.
      //
      //  `application/json` on a 200 means the endpoint decided to answer with
      //  something other than a stream: reading the body is the right move,
      //  because it usually explains why.
      //
      //  No content-type at all proves nothing. The Codex backend sends a
      //  perfectly well-formed event stream with the header omitted, and
      //  rejecting it threw away a working response over a missing label.
      //  Here the body itself is the evidence, so the stream reader decides: if
      //  it is not SSE it yields no events and fails on its own terms.
      const contentType = res.headers.get('content-type') || '';
      if (contentType && !/text\/event-stream/i.test(contentType)) {
        const bodyText = await res.text().catch(() => '');
        this._writeApiLog('response', wireBody.model, url, {
          http: {
            status: res.status,
            contentType,
            headers: _responseHeaders(res.headers)
          },
          body: bodyText
        }, {
          ...logMeta,
          upstreamRequestId,
          durationMs: Date.now() - startedAt
        });
        throw this._error(
          TRANSPORT_ERROR.MALFORMED,
          `Expected an event stream, got "${contentType}": ${summarizeErrorBody(bodyText)}`,
          { requestId: upstreamRequestId }
        );
      }
      if (!contentType && !this._notedMissingContentType) {
        this._notedMissingContentType = true;
        this._log.info('response carried no content-type; reading it as an event stream (said once per run)');
      }

      let assembled;
      const streamCapture = { receivedBytes: 0, events: [], assembledResponse: null };
      try {
        assembled = await consumeResponseStream({
          response: res,
          budget,
          requestId: upstreamRequestId,
          capture: streamCapture,
          errorFactory: (kind, message, extra) => this._error(kind, message, extra),
          log: this._log
        });
      } catch (err) {
        this._writeApiLog('response', wireBody.model, url, {
          http: {
            status: res.status,
            contentType: contentType || null,
            headers: _responseHeaders(res.headers)
          },
          stream: streamCapture,
          error: { kind: err.kind || null, name: err.name, message: err.message, partial: Boolean(err.partial) }
        }, {
          ...logMeta,
          upstreamRequestId,
          durationMs: Date.now() - startedAt
        });
        // A stream that produced nothing can be replayed: no tool ran and no
        // partial reply exists. Anything else is reported as it is.
        if (isRetryableKind(err.kind) && !err.partial && attempt < MAX_COLD_ATTEMPTS) {
          this._log.warn(`stream attempt ${attempt} produced nothing: ${err.message}`);
          await sleepWithin(Math.min(attempt * 2000, budget.remainingMs), budget.signal);
          continue;
        }
        throw err;
      }

      this._writeApiLog('response', wireBody.model, url, {
        http: {
          status: res.status,
          contentType: contentType || null,
          headers: _responseHeaders(res.headers)
        },
        stream: streamCapture,
        assembledResponse: assembled.response
      }, {
        ...logMeta,
        upstreamRequestId,
        durationMs: Date.now() - startedAt
      });
      await this.credentials.markStatus('ok', credential.accountId);
      this._log.info(
        `model=${wireBody.model} effort=${wireBody.reasoning?.effort ?? 'n/a'} `
        + `status=${assembled.response.status ?? 'unknown'} items=${assembled.response.output.length} `
        + `durationMs=${Date.now() - startedAt} attempt=${attempt} requestId=${upstreamRequestId ?? 'n/a'}`
        + (assembled.response.usage ? ` tokens=${assembled.response.usage.total_tokens ?? '?'}` : '')
      );
      return assembled;
    }

    throw this._error(TRANSPORT_ERROR.TRANSIENT, 'Model request failed: retry budget exhausted.');
  }

  /** Authorization plus whatever the profile's extension adds. Never logged. */
  _buildHeaders(credential, context) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${credential.accessToken}`,
      ...(credential.headers || {})
    };
    if (this.extensions?.decorateHeaders) {
      return this.extensions.decorateHeaders(headers, context) || headers;
    }
    return headers;
  }

  _writeApiLog(kind, model, url, body, extra) {
    try {
      this._apiLogWriter?.[kind]?.(model, url, body, extra);
    } catch (err) {
      this._log.warn(`API ${kind} log sink failed: ${err.message}`);
    }
  }

  _error(kind, message, extra = {}) {
    return new TransportError(kind, message, {
      ...extra,
      providerId: this.extensions?.providerId || this.label
    });
  }
}

export {
  OpenAIResponsesTransport
};
