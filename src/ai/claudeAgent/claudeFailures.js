// src/ai/claudeAgent/claudeFailures.js
//
// The Claude Agent runtime's refusals, as the typed failures every runtime
// raises (transport/errors.js), and the quota guard of the subscription.
//
// The guard is fail-closed: once the plan rejects a request, or a request
// starts drawing on usage beyond the plan, the turn ends as QUOTA instead of
// running on.

import {
  TRANSPORT_ERROR,
  TransportError,
  classifyHttpFailure,
  classifyStreamFailure
} from '../transport/errors.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ClaudeQuota');

/** Kinds for the `error` Claude Code puts on an assistant message it could not get. */
const ASSISTANT_ERROR_KINDS = Object.freeze({
  authentication_failed: TRANSPORT_ERROR.AUTH,
  oauth_org_not_allowed: TRANSPORT_ERROR.AUTH,
  account_on_hold: TRANSPORT_ERROR.AUTH,
  verification_required: TRANSPORT_ERROR.AUTH,
  cloud_credential_error: TRANSPORT_ERROR.AUTH,
  rate_limit: TRANSPORT_ERROR.RATE_LIMIT,
  overloaded: TRANSPORT_ERROR.RATE_LIMIT,
  server_error: TRANSPORT_ERROR.TRANSIENT,
  invalid_request: TRANSPORT_ERROR.UNSUPPORTED_INPUT
});

/** Claude Code's own wording when it has no usable credential. */
const CREDENTIAL_NOTICE_RE = /not logged in|failed to authenticate/i;

function _detail(text) {
  return typeof text === 'string' ? text.trim().slice(0, 300) : '';
}

/**
 * The failure of a turn whose result reports an error.
 *
 * @param {object} result - the SDK result message (`is_error`, or an error subtype)
 * @param {{ assistantError?: string|null, rateLimit?: object|null }} seen - the
 *   last assistant error and rate-limit state of the turn
 * @returns {TransportError}
 */
function resultFailure(result, { assistantError = null, rateLimit = null } = {}) {
  const detail = _detail(Array.isArray(result.errors) && result.errors.length > 0
    ? result.errors.join('; ')
    : result.result);
  const status = Number.isInteger(result.api_error_status) ? result.api_error_status : null;

  let kind;
  if (assistantError === 'rate_limit' && rateLimit?.status === 'rejected') kind = TRANSPORT_ERROR.QUOTA;
  else if (ASSISTANT_ERROR_KINDS[assistantError]) kind = ASSISTANT_ERROR_KINDS[assistantError];
  else if (status !== null) kind = classifyHttpFailure(status, detail);
  else if (CREDENTIAL_NOTICE_RE.test(detail)) kind = TRANSPORT_ERROR.AUTH;
  else kind = classifyStreamFailure(detail);

  const cause = assistantError || result.subtype;
  return new TransportError(kind, `Claude Code ended the turn (${cause})${detail ? `: ${detail}` : ''}`, {
    status,
    providerId: 'claude'
  });
}

/** The utilization of each limit window the event reports. */
function _windows(info) {
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
  if (unified) {
    return Object.entries(unified)
      .filter(([, window]) => Number.isFinite(window?.utilization))
      .map(([type, window]) => ({ type, utilization: window.utilization, resetsAt: window.resetsAt }));
  }
  return Number.isFinite(info.utilization)
    ? [{ type: info.rateLimitType || 'plan', utilization: info.utilization, resetsAt: info.resetsAt }]
    : [];
}

function _resetTime(resetsAt) {
  return Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : 'unknown';
}

/** One log line for a rate-limit state: status, then each window's use and reset. */
function describeRateLimit(info) {
  const windows = _windows(info)
    .map(window => `${window.type} ${Math.round(window.utilization * 100)}% (resets ${_resetTime(window.resetsAt)})`);
  return [info.status, ...windows].join(', ');
}

/**
 * Read one rate-limit event: log it and say whether the turn has to stop.
 *
 * @param {object} info - the event's `rate_limit_info`
 * @returns {TransportError|null} QUOTA when the plan rejected the request or
 *   the request drew on usage beyond the plan
 */
function rateLimitFailure(info) {
  log.info(`   Claude plan usage: ${describeRateLimit(info)}`);
  if (info.isUsingOverage === true || info.overageInUse === true) {
    return new TransportError(TRANSPORT_ERROR.QUOTA,
      `Claude plan limit reached and the request drew on extra usage; stopped (${describeRateLimit(info)})`,
      { providerId: 'claude' });
  }
  if (info.status === 'rejected') {
    return new TransportError(TRANSPORT_ERROR.QUOTA,
      `Claude plan limit reached (${describeRateLimit(info)})`,
      { providerId: 'claude' });
  }
  return null;
}

export { describeRateLimit, rateLimitFailure, resultFailure };
