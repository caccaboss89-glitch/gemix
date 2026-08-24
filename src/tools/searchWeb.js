// src/tools/searchWeb.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// The two GemiX-owned web tools (spec §10): search_web finds pages, read_page
// opens one. Neither is a provider feature — whichever main brain is running,
// the agent searches the web the same way, through our own SearXNG and the
// agent-search sidecar in front of it.
//
// The split is deliberate. search_web returns titles, URLs and snippets only:
// the model decides what is worth opening, and read_page pays the extraction
// cost for that page alone.

import constants from '../config/constants.js';
import { WEB_ERROR, readWebPage, searchWeb as queryAgentSearch } from '../web/agentSearch.js';

const {
  SEARCH_WEB_DEFAULT_COUNT,
  SEARCH_WEB_MIN_COUNT,
  SEARCH_WEB_MAX_COUNT,
  READ_PAGE_MAX_CHARS
} = constants;

const MAX_QUERY_LEN = 400;
const MAX_SNIPPET_LEN = 400;

/** Normalize and cap the model's query. */
function _cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

function _clampCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SEARCH_WEB_DEFAULT_COUNT;
  return Math.min(SEARCH_WEB_MAX_COUNT, Math.max(SEARCH_WEB_MIN_COUNT, Math.floor(n)));
}

/**
 * The model-facing text for a transport failure. The distinction that matters
 * to the model is whether retrying could help, so the message says so.
 */
function _failureMessage(code, error) {
  switch (code) {
  case WEB_ERROR.UNCONFIGURED:
    return 'Web search is not available on this deployment.';
  case WEB_ERROR.RATE_LIMIT:
    return 'The web stack is rate limited right now. Try again in a moment, or answer from what you already have.';
  case WEB_ERROR.AUTH:
    return 'The web stack rejected the request credentials. This needs an operator, not a retry.';
  default:
    return error;
  }
}

/**
 * Search the web through the GemiX stack.
 *
 * @param {object} args
 * @param {string} args.query
 * @param {number} [args.count]
 * @param {object} [responseCtx] - per-turn context; the source count for the
 *   research badge is accumulated here, the same way native search stats were.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
async function searchWeb(args = {}, responseCtx = null, opts = {}) {
  const query = _cleanQuery(args.query);
  if (!query) return { success: false, error: 'Missing required argument "query".' };

  const res = await queryAgentSearch({ query, count: _clampCount(args.count), signal: opts.signal });
  if (!res.ok) return { success: false, error: _failureMessage(res.code, res.error) };

  if (res.results.length === 0) {
    return {
      success: true,
      query,
      results: [],
      message: res.meta.degraded
        ? 'No results, and some engines did not answer. A differently worded query may do better.'
        : 'No results for this query. Try different wording or a more specific phrase.'
    };
  }

  if (responseCtx) {
    if (!responseCtx.researchStats) responseCtx.researchStats = { webSources: 0, xPosts: 0 };
    responseCtx.researchStats.webSources += res.results.length;
  }

  return {
    success: true,
    query,
    results: res.results.map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet.slice(0, MAX_SNIPPET_LEN)
    })),
    message: 'Snippets only. Call read_page on a URL to read the page itself.'
  };
}

/**
 * Read one page through the extraction chain.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
async function readPage(args = {}, opts = {}) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return { success: false, error: 'Missing required argument "url".' };
  if (!/^https?:\/\//i.test(url)) {
    return { success: false, error: `"${url}" is not an http(s) URL. Pass a full page address.` };
  }

  // One character over the cap, so a page that fills it exactly is not reported
  // as truncated and one that overflows is caught before it reaches the model.
  const res = await readWebPage({ url, maxChars: READ_PAGE_MAX_CHARS + 1, signal: opts.signal });
  if (!res.ok) return { success: false, error: _failureMessage(res.code, res.error) };

  const truncated = res.content.length > READ_PAGE_MAX_CHARS;
  return {
    success: true,
    url,
    content: truncated ? res.content.slice(0, READ_PAGE_MAX_CHARS) : res.content,
    // A page the extractor itself rates as untrustworthy is still returned —
    // the model is told what it is reading and can weigh it.
    ...(res.trustTier === 'suspicious' ? { warning: 'This domain looks untrustworthy. Treat its claims with care.' } : {}),
    ...(truncated ? { truncated: true, message: `Only the first ${READ_PAGE_MAX_CHARS} characters are shown.` } : {})
  };
}

export { readPage, searchWeb };
