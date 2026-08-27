// src/ai/extensions/xaiResponsesExtensions.js
//
// Everything xAI-specific about a Responses request, kept behind one boundary
// so the transport itself stays generic.
//
// What lives here:
//   - the sticky-routing header xAI uses alongside prompt_cache_key;
//   - the one xAI-only body field, max_turns;
//   - the extra output item types xAI emits and accepts back on replay;
//   - the native `x_search` tool object, which adds xAI's X-only family beside
//     GemiX's ordinary web tools;
//   - the xAI HTTP bodies whose meaning depends on the configured auth mode.
//
// What does NOT live here: anything about files, the workspace, the web stack
// or media backends. Those are feature bindings, and they are GemiX's.

import { BASE_REPLAYABLE_ITEM_TYPES } from '../transport/responsesProtocol.js';
import { TRANSPORT_ERROR } from '../transport/errors.js';
import envConfig from '../../config/env.js';

/**
 * Output item types xAI adds on top of the base Responses set. They are the
 * server-side call records for its own tool family; replaying them by reference
 * is what keeps a multi-round X search coherent.
 */
const XAI_SERVER_SIDE_ITEM_TYPES = Object.freeze(['custom_tool_call', 'x_search_call']);

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
  enable_image_understanding: true,
  enable_video_understanding: true
});

// `view_x_video` belongs to the native family but is media inspection, not a
// search. The research badge counts searches only, so it is absent here.
const X_SEARCH_TOOL_NAMES = new Set([
  'x_keyword_search',
  'x_semantic_search',
  'x_user_search',
  'x_thread_fetch'
]);

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
 * With SuperGrok OAuth, an exhausted team allowance can surface in this form
 * after a refresh. A static API key can receive the same body when the key is
 * bad or revoked, so auth mode decides whether it is quota or authentication.
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

  /** Classify xAI's explicit limit and OAuth-only exhausted-allowance bodies. */
  refineHttpFailure(status, bodyText) {
    if ((status === 403 || status === 429) && _isSpendingLimitBody(bodyText)) return TRANSPORT_ERROR.QUOTA;
    if (!envConfig.XAI_USE_API_KEY
        && status === 403
        && _isOAuthUnauthenticatedBody(bodyText)) {
      return TRANSPORT_ERROR.QUOTA;
    }
    return null;
  },

  /**
   * Server-side search statistics for the research badge appended to replies.
   * xAI does not expose the number of returned posts in its response. Count
   * observable completed X-family calls instead; never reinterpret the input
   * `limit` as a result count. The web count stays zero because GemiX owns web
   * search on every profile and reports its own sources.
   *
   * @param {object} response - assembled Responses payload
   * @returns {{ webSources: number, xSearches: number }}
   */
  extractSearchStats(response) {
    let xSearches = 0;
    for (const item of Array.isArray(response?.output) ? response.output : []) {
      if (item?.type === 'x_search_call') {
        if (!item.status || item.status === 'completed') xSearches += 1;
        continue;
      }
      if (item?.type !== 'custom_tool_call' || typeof item.name !== 'string') continue;
      if (!X_SEARCH_TOOL_NAMES.has(item.name)) continue;
      if (item.status && item.status !== 'completed') continue;
      xSearches += 1;
    }
    return { webSources: 0, xSearches };
  }
});

export {
  xaiResponsesExtensions,
  XAI_X_SEARCH_TOOL
};
