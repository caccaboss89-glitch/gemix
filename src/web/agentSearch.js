// src/web/agentSearch.js
//
// Client for the agent-search sidecar, the layer GemiX puts in front of its own
// SearXNG instance. It answers two questions: what is on the
// web about this, and what does this page actually say.
//
// The sidecar is deliberately behind this module rather than exposed to the
// rest of the program: the tool contracts are GemiX's, so replacing agent-search
// with something else — or with a Node layer of our own — is a change here and
// nowhere else.
//
// Two endpoints are used, both GET:
//   /search?q=&count=&fetch=false  -> { results: [{title,url,snippet,engines,score,position}], meta }
//   /read?url=&max_chars=          -> { url, content, strategy, chars, success, error, trust }
// The rest of the sidecar's surface (strategy modes, job boards, the adaptive
// evolver) is not wired up: the model gets one way to search and one way to
// read, and those are the two the prompt teaches.

import envConfig from '../config/env.js';
import { fetchWithTimeout } from '../utils/fetch.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AgentSearch');

/** Failure kinds the tools translate into their own messages. */
const WEB_ERROR = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED',
  UNREACHABLE: 'UNREACHABLE',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  BAD_REQUEST: 'BAD_REQUEST',
  UPSTREAM: 'UPSTREAM'
});

// A search is a fan-out across engines; a read can escalate all the way to a
// browser render, so it gets the longer budget of the two.
const SEARCH_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;

/** True when a base URL is set at all. There is no cloud fallback for this. */
function isAgentSearchConfigured() {
  const base = String(envConfig.AGENT_SEARCH_BASE_URL || '');
  return /^https?:\/\//i.test(base);
}

function _headers() {
  const headers = { Accept: 'application/json' };
  if (envConfig.AGENT_SEARCH_TOKEN) {
    headers.Authorization = `Bearer ${envConfig.AGENT_SEARCH_TOKEN}`;
  }
  return headers;
}

function _classifyStatus(status) {
  if (status === 401 || status === 403) return WEB_ERROR.AUTH;
  if (status === 429) return WEB_ERROR.RATE_LIMIT;
  if (status === 400 || status === 422) return WEB_ERROR.BAD_REQUEST;
  return WEB_ERROR.UPSTREAM;
}

/**
 * One GET against the sidecar, returning the parsed body or a classified
 * failure. Never throws: the tools above turn the code into model-facing text.
 *
 * @param {string} path - endpoint path, e.g. '/search'
 * @param {Record<string, string>} params
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: true, data: object}|{ok: false, code: string, error: string}>}
 */
async function _get(path, params, timeoutMs, signal) {
  if (!isAgentSearchConfigured()) {
    return {
      ok: false,
      code: WEB_ERROR.UNCONFIGURED,
      error: 'The web stack is not configured (AGENT_SEARCH_BASE_URL is not a valid URL).'
    };
  }

  const base = String(envConfig.AGENT_SEARCH_BASE_URL).replace(/\/+$/, '');
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: _headers(), signal }, timeoutMs);
  } catch (err) {
    log.warn(`${path} request failed: ${err.message}`);
    return {
      ok: false,
      code: WEB_ERROR.UNREACHABLE,
      error: `The web stack is unreachable at ${base}: ${err.message}`
    };
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) {
    const code = _classifyStatus(res.status);
    log.warn(`${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
    return { ok: false, code, error: `The web stack returned HTTP ${res.status}.` };
  }

  try {
    return { ok: true, data: JSON.parse(body) };
  } catch (err) {
    log.warn(`${path} invalid JSON: ${err.message}`);
    return { ok: false, code: WEB_ERROR.UPSTREAM, error: 'The web stack returned a malformed response.' };
  }
}

/**
 * Deduplicated, scored web results for one query.
 *
 * `fetch=false`: page bodies are not pulled here. The model picks what is worth
 * opening from the snippets and calls read_page for that one, instead of paying
 * for ten extractions it did not ask for.
 *
 * @param {object} req
 * @param {string} req.query
 * @param {number} req.count
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<{ok: true, results: Array, meta: object}|{ok: false, code: string, error: string}>}
 */
async function searchWeb({ query, count, signal }) {
  const res = await _get('/search', { q: query, count, fetch: 'false' }, SEARCH_TIMEOUT_MS, signal);
  if (!res.ok) return res;

  const raw = Array.isArray(res.data?.results) ? res.data.results : [];
  const results = raw.map((hit) => ({
    title: typeof hit?.title === 'string' ? hit.title.trim() : '',
    url: typeof hit?.url === 'string' ? hit.url.trim() : '',
    snippet: typeof hit?.snippet === 'string' ? hit.snippet.trim() : '',
    engines: Array.isArray(hit?.engines) ? hit.engines.filter((e) => typeof e === 'string') : []
  })).filter((hit) => hit.url);

  const meta = res.data?.meta || {};
  return {
    ok: true,
    results,
    meta: {
      enginesUsed: Array.isArray(meta.engines_used) ? meta.engines_used : [],
      // The sidecar answers with whatever engines did respond, so a degraded
      // upstream is a note on a real result, not a failure of the call.
      degraded: meta.upstream_status && meta.upstream_status !== 'ok',
      unresponsiveEngines: Array.isArray(meta.unresponsive_engines) ? meta.unresponsive_engines : []
    }
  };
}

/**
 * The readable content of one page, as markdown-ish text.
 *
 * @param {object} req
 * @param {string} req.url
 * @param {number} [req.maxChars]
 * @param {AbortSignal} [req.signal]
 * @returns {Promise<{ok: true, content: string, strategy: string, chars: number, trustTier: string}
 *   |{ok: false, code: string, error: string}>}
 */
async function readWebPage({ url, maxChars, signal }) {
  const res = await _get('/read', { url, max_chars: maxChars }, READ_TIMEOUT_MS, signal);
  if (!res.ok) return res;

  const data = res.data || {};
  if (!data.success || typeof data.content !== 'string' || !data.content.trim()) {
    // Every strategy in the chain ran and none produced text: that is an answer
    // about the page, not a transport failure, so it says which were tried.
    const tried = Array.isArray(data.strategies_tried) ? data.strategies_tried.join(', ') : '';
    return {
      ok: false,
      code: WEB_ERROR.UPSTREAM,
      error: data.error
        ? `Could not read the page: ${data.error}`
        : `Could not read the page${tried ? ` (tried: ${tried})` : ''}.`
    };
  }

  return {
    ok: true,
    content: data.content,
    strategy: typeof data.strategy === 'string' ? data.strategy : '',
    chars: Number.isFinite(data.chars) ? data.chars : data.content.length,
    trustTier: typeof data.trust?.tier === 'string' ? data.trust.tier : 'unknown'
  };
}

export {
  WEB_ERROR,
  isAgentSearchConfigured,
  readWebPage,
  searchWeb
};
