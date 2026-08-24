// src/ai/extensions/xaiResponsesExtensions.js
//
// Everything xAI-specific about a Responses request, kept behind one boundary
// so the transport itself stays generic.
//
// What lives here:
//   - the sticky-routing header xAI uses alongside prompt_cache_key;
//   - the one xAI-only body field, max_turns;
//   - the extra output item types xAI emits and accepts back on replay;
//   - the native `x_search` tool object, and the rule that its family replaces
//     GemiX's own definitions when declared;
//   - the two HTTP 403 bodies that mean "credits exhausted", not "bad token".
//
// What does NOT live here: anything about files, the workspace, the web stack
// or media backends. Those are feature bindings, and they are GemiX's.

import { BASE_REPLAYABLE_ITEM_TYPES } from '../transport/responsesProtocol.js';
import { TRANSPORT_ERROR } from '../transport/errors.js';

/**
 * Output item types xAI adds on top of the base Responses set. They are the
 * server-side call records for its own tool family; replaying them by reference
 * is what keeps a multi-round X search coherent.
 */
const XAI_SERVER_SIDE_ITEM_TYPES = Object.freeze(['web_search_call', 'custom_tool_call']);

const XAI_REPLAYABLE_ITEM_TYPES = Object.freeze([
  ...BASE_REPLAYABLE_ITEM_TYPES,
  ...XAI_SERVER_SIDE_ITEM_TYPES
]);

/**
 * The native X search tool.
 *
 * Verified by prompt-leak probe: declaring this type does not put a tool called
 * `x_search` in front of the model — it switches on xAI's own X family
 * (x_user_search, x_semantic_search, x_keyword_search, x_thread_fetch,
 * view_x_video), which the model calls server-side. GemiX never sees those as
 * tool calls; it only counts them for the research badge.
 *
 * The hosted `web_search` type is deliberately absent and must stay absent:
 * normal web search is GemiX-owned on every profile.
 */
const XAI_X_SEARCH_TOOL = Object.freeze({
  type: 'x_search',
  limit: 5,
  enable_image_understanding: true,
  enable_video_understanding: true
});

/**
 * How many posts each X sub-tool is worth for the research badge. The keyword
 * and semantic searches carry a `limit` in their call input; the rest are one
 * item each.
 */
const X_CUSTOM_TOOL_ESTIMATE = Object.freeze({
  x_keyword_search: (input) => _limitFromCustomToolInput(input),
  x_semantic_search: (input) => _limitFromCustomToolInput(input),
  x_user_search: () => 1,
  x_thread_fetch: () => 1,
  view_x_video: () => 1
});

function _limitFromCustomToolInput(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return 0; }
  }
  if (!obj || typeof obj !== 'object') return 0;
  const limit = obj.limit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) return Math.floor(limit);
  if (typeof limit === 'string') {
    const n = parseInt(limit, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * True when an HTTP 403/429 body is the xAI spending-limit refusal
 * (`personal-team-blocked:spending-limit`), possibly wrapped in other text.
 */
function _isSpendingLimitBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.includes('personal-team-blocked')) return false;
  return /personal-team-blocked:spending-limit/.test(bodyText);
}

/**
 * True when an HTTP 403 body is the OAuth "bad-credentials" refusal.
 *
 * Once the SuperGrok team credits run out, xAI's spending-limit body morphs
 * into this one, so on this deployment it means the same thing: the allowance is
 * spent, not that the token went bad. Classifying it as QUOTA is what keeps the
 * user-facing credit notice correct and the admin unalerted.
 */
function _isOAuthUnauthenticatedBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return false;
  if (/"code"\s*:\s*"unauthenticated/.test(bodyText)) return true;
  return /could not be validated/i.test(bodyText);
}

const xaiResponsesExtensions = Object.freeze({
  providerId: 'xai',
  replayableItemTypes: XAI_REPLAYABLE_ITEM_TYPES,
  /**
   * Sticky routing. `prompt_cache_key` is standard Responses and the generic
   * body builder already sets it; this header is the xAI half of the same
   * mechanism — its backend routes a conversation on it, which is what keeps
   * the prefix cache warm across the rounds of one turn.
   */
  decorateHeaders(headers, context = {}) {
    const convId = typeof context.promptCacheKey === 'string' ? context.promptCacheKey : '';
    if (convId) headers['x-grok-conv-id'] = convId;
    return headers;
  },

  /** The one body field that exists on xAI alone. */
  decorateBody(body, context = {}) {
    // Bounds the server-side sub-tool turns (the X family) inside one request.
    if (Number.isFinite(context.maxTurns)) body.max_turns = context.maxTurns;
    return body;
  },

  /**
   * The two 403 bodies above are an exhausted allowance, not an auth problem:
   * refreshing the credential cannot help and the user gets the credit notice.
   */
  refineHttpFailure(status, bodyText) {
    if ((status === 403 || status === 429) && _isSpendingLimitBody(bodyText)) return TRANSPORT_ERROR.QUOTA;
    if (status === 403 && _isOAuthUnauthenticatedBody(bodyText)) return TRANSPORT_ERROR.QUOTA;
    return null;
  },

  /**
   * Server-side search statistics for the research badge appended to replies.
   * X posts are estimated from the `custom_tool_call` records; the web count
   * stays zero because GemiX owns web search on every profile and reports its
   * own sources.
   *
   * @param {object} response - assembled Responses payload
   * @returns {{ webSources: number, xPosts: number }}
   */
  extractSearchStats(response) {
    let xPosts = 0;
    for (const item of Array.isArray(response?.output) ? response.output : []) {
      if (item?.type !== 'custom_tool_call' || typeof item.name !== 'string') continue;
      const estimate = X_CUSTOM_TOOL_ESTIMATE[item.name];
      if (estimate) xPosts += estimate(item.input);
    }
    return { webSources: 0, xPosts };
  }
});

export {
  xaiResponsesExtensions,
  XAI_X_SEARCH_TOOL
};
