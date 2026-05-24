// src/tools/webXSearch.js
//
// Single research tool that delegates to xAI's grok-4.20-multi-agent.
//
// The main model (Grok 4.3 via Hermes) does NOT call xAI's native search tools.
// Instead, it produces a research brief and hands it off to the multi-agent team
// here. The team uses Grok's *server-side* `web_search` (which already covers
// page browsing) and `x_search` to gather information, then returns a synthesized
// answer with citations.
//
// Endpoint: POST {HERMES_BASE_URL}/responses (Hermes proxies the request to xAI
// and forwards the SuperGrok OAuth token; GemiX never holds an xAI API key).
//
// Auth: HERMES_API_KEY (the proxy ignores the value and uses its own OAuth).

const { HERMES_API_KEY, HERMES_BASE_URL, MULTI_AGENT_MODEL } = require('../config/env');
const { logApiRequest, logApiResponse } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { getRomeTime } = require('../utils/time');
const { createLogger } = require('../utils/logger');

const log = createLogger('WebXSearch');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

// SuperGrok plan only allows the 4-agent in high effort.
// Hardcoded here so the main model can't accidentally request the unsupported tier.
const FIXED_EFFORT = 'high';

// Number of results requested per web/X search call.
// Higher values give the sub-agents more raw material per query.
const WEB_NUM_RESULTS = 15;
const X_LIMIT = 15;

// 4-agent runs typically resolve in 30-90s. Give some headroom for slow searches.
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const MAX_PROMPT_LEN = 4000;

// ── Response parsing ────────────────────────────────────────────────────────

/**
 * Pull the synthesized text out of an xAI Responses API payload.
 * Tries the SDK convenience field first, then walks the `output` array
 * (the actual on-the-wire shape) for any text content parts.
 *
 * @param {object} data - Parsed JSON response body
 * @returns {string|null} Combined text, or null if no text could be extracted
 */
function _extractOutputText(data) {
  if (!data || typeof data !== 'object') return null;

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.output)) return null;

  const texts = [];
  for (const item of data.output) {
    if (!item) continue;
    // Some shapes put the text directly on the output item.
    if (typeof item.text === 'string' && item.text.trim()) {
      texts.push(item.text.trim());
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part) continue;
        if (typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        } else if (part.text && typeof part.text.value === 'string' && part.text.value.trim()) {
          texts.push(part.text.value.trim());
        }
      }
    }
  }

  return texts.length > 0 ? texts.join('\n\n').trim() : null;
}

/**
 * Walk the response and collect every URL the team consulted.
 * Citations may live in `data.citations`, `output[].citations`, or as
 * annotations inside output content parts — handle them all.
 *
 * @param {object} data - Parsed JSON response body
 * @returns {string[]} Deduplicated list of source URLs (insertion order preserved)
 */
function _extractCitations(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;

  const seen = new Set();
  const push = (raw) => {
    const url = (typeof raw === 'string') ? raw : raw?.url;
    if (typeof url !== 'string') return;
    const key = url.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  if (Array.isArray(data.citations)) {
    data.citations.forEach(push);
  }

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (!item) continue;
      if (Array.isArray(item.citations)) item.citations.forEach(push);
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (Array.isArray(part.annotations)) {
            for (const ann of part.annotations) {
              if (ann && (typeof ann.url === 'string' || typeof ann.uri === 'string')) {
                push(ann.url || ann.uri);
              }
            }
          }
          if (Array.isArray(part.citations)) part.citations.forEach(push);
        }
      }
    }
  }

  return out;
}

// ── Usage stats extraction ──────────────────────────────────────────────────

/**
 * Extract search usage stats from an xAI Responses API payload.
 *
 * Priority 1 — server-side totals (most accurate, covers all sub-agents):
 *   data.usage.server_side_tool_usage_details.web_search_calls  → total web searches
 *   data.usage.server_side_tool_usage_details.x_search_calls    → total X searches
 *
 *   These are the same numbers the official Grok app displays. The multi-agent
 *   team spawns sub-agents whose tool calls are NOT visible in `output[]` (they
 *   are encrypted/hidden), so counting visible items always under-reports.
 *
 * Priority 2 — visible output items (fallback when server totals are absent):
 *   Walk output[] and count sources from web_search_call actions and
 *   x_keyword_search / x_search custom_tool_call items.
 *
 * @param {object} data - Parsed JSON response body
 * @returns {{ webSources: number, xPosts: number, _source: string, _debugWebCalls?: number, _debugXCalls?: string }}
 */
function _extractUsageStats(data) {
  // ── Priority 1: authoritative server-side totals ─────────────────────────
  const details = data?.usage?.server_side_tool_usage_details;
  if (details && (details.web_search_calls > 0 || details.x_search_calls > 0)) {
    return {
      webSources: details.web_search_calls || 0,
      xPosts: details.x_search_calls || 0,
      _source: 'server_side_tool_usage_details',
      _debugWebCalls: details.web_search_calls || 0,
      _debugXCalls: `x_search_calls=${details.x_search_calls || 0}`,
    };
  }

  // ── Priority 2: fallback — count visible tool calls in output[] ──────────
  // Only reached when the server omits usage details (e.g. older API versions).
  let webSources = 0;
  let xPosts = 0;
  let debugWebSearchCount = 0;
  const debugXCalls = [];

  if (!Array.isArray(data?.output)) {
    return { webSources, xPosts, _source: 'none' };
  }

  for (const item of data.output) {
    if (!item) continue;

    // ── Web Search Calls ──────────────────────────────────────────────────
    if (item.type === 'web_search_call' && item.action) {
      debugWebSearchCount++;
      if (item.action.type === 'search' && Array.isArray(item.action.sources)) {
        webSources += item.action.sources.length;
      } else if (item.action.type === 'open_page' && typeof item.action.url === 'string') {
        webSources += 1;
      }
    }

    // ── X / Twitter Search Calls ──────────────────────────────────────────
    if (item.type === 'custom_tool_call' &&
        (item.name === 'x_keyword_search' || item.name === 'x_search')) {
      let xCount = 0;
      let xCountSource = 'unknown';

      if (item.result && typeof item.result === 'object') {
        if (Array.isArray(item.result.data)) {
          xCount = item.result.data.length; xCountSource = 'result.data';
        } else if (Array.isArray(item.result.tweets)) {
          xCount = item.result.tweets.length; xCountSource = 'result.tweets';
        } else if (Array.isArray(item.result.results)) {
          xCount = item.result.results.length; xCountSource = 'result.results';
        } else if (item.result.count) {
          xCount = Number(item.result.count) || 0; xCountSource = 'result.count';
        }
      }

      if (xCount === 0 && typeof item.input === 'string') {
        try {
          const inputObj = JSON.parse(item.input);
          if (inputObj.limit) { xCount = Number(inputObj.limit) || 0; xCountSource = 'input.limit'; }
        } catch { /* not JSON */ }
      }

      xPosts += Math.max(xCount, 0);
      debugXCalls.push(`${item.name}→${xCount}(${xCountSource})`);
    }
  }

  return {
    webSources,
    xPosts,
    _source: 'visible_output_fallback',
    _debugWebCalls: debugWebSearchCount,
    _debugXCalls: debugXCalls.join(', ') || 'none',
  };
}

/**
 * Hit POST /v1/responses with retry/timeout, returning the parsed JSON body.
 * Errors are logged and re-thrown after notifying the admin on the final attempt.
 */
async function _callMultiAgent(prompt) {
  // The multi-agent team runs without GemiX's system prompt and without
  // chat history — they only see this `input`. Prepend a Context block so
  // the agents always know the current date when interpreting "recent",
  // "latest", "this week", etc., without relying on the calling model to
  // remember to put it in the brief.
  const contextBlock = `[Context]\nCurrent date and time (Europe/Rome): ${getRomeTime()}\n[/Context]\n\n[Research brief]\n${prompt}`;

  const body = {
    model: MULTI_AGENT_MODEL,
    reasoning: { effort: FIXED_EFFORT },
    input: [{ role: 'user', content: contextBlock }],
    tools: [
      {
        type: 'web_search',
        num_results: WEB_NUM_RESULTS,
      },
      {
        type: 'x_search',
        limit: X_LIMIT,
      },
    ]
  };

  logApiRequest(MULTI_AGENT_MODEL, RESPONSES_URL, body);
  log.info(`   📡 → ${MULTI_AGENT_MODEL} (input: ${contextBlock.length} chars)`);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startTime = Date.now();
    try {
      const res = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HERMES_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const short = errBody.startsWith('<!') ? 'Cloudflare error' : errBody.substring(0, 500);
        throw new Error(`HTTP ${res.status}: ${short}`);
      }

      const data = await res.json();
      const duration = Date.now() - startTime;
      try { logApiResponse(MULTI_AGENT_MODEL, RESPONSES_URL, data); } catch { /* logging best effort */ }
      log.info(`   ✅ multi-agent reply in ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return data;

    } catch (err) {
      lastErr = err;
      const isTimeout = err.name === 'AbortError';
      const msg = isTimeout ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : err.message;
      const isRetryable = isTimeout
        || /HTTP (429|5\d{2})/.test(err.message || '')
        || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(err.message || '');

      if (isRetryable && attempt < MAX_ATTEMPTS) {
        const delay = attempt * 4000;
        log.warn(`   ⚠️ multi-agent attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg} — retry in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      log.error(`   ❌ multi-agent error: ${msg}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  await notifyAdmin('WebXSearch (multi-agent)', `Error after ${MAX_ATTEMPTS} attempt(s): ${lastErr?.message || 'unknown'}`);
  throw new Error(`Research team unavailable: ${lastErr?.message || 'unknown error'}${ADMIN_NOTIFIED_SUFFIX}`);
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Hand a research brief to the grok-4.20-multi-agent team (4-agent tier).
 *
 * The team performs web search (which already covers page-browsing) and
 * X/Twitter search using xAI's native server-side tools, then synthesizes
 * the findings. The main model (Grok 4.3) only sees the structured report
 * returned here.
 *
 * @param {string} prompt - The research brief from the main model.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function webXSearch(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return {
      success: false,
      error: 'Missing "prompt": describe what to research, including any specific URLs or domains to inspect.',
    };
  }

  // Strip control chars, collapse whitespace, trim.
  let cleanPrompt = prompt
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (cleanPrompt.length < 5) {
    return { success: false, error: 'Prompt too short: provide a clear and specific research request.' };
  }
  let truncated = false;
  if (cleanPrompt.length > MAX_PROMPT_LEN) {
    cleanPrompt = cleanPrompt.substring(0, MAX_PROMPT_LEN);
    truncated = true;
  }

  if (!HERMES_API_KEY) {
    return { success: false, error: 'HERMES_API_KEY is not configured — research team is unavailable.' };
  }
  if (!MULTI_AGENT_MODEL) {
    return { success: false, error: 'MULTI_AGENT_MODEL is not configured — research team is unavailable.' };
  }

  log.info(`🔎 Research request (${cleanPrompt.length} chars${truncated ? ', truncated' : ''})`);

  let data;
  try {
    data = await _callMultiAgent(cleanPrompt);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const text = _extractOutputText(data);
  if (!text) {
    return { success: false, error: 'Research team returned an empty response. Try again with a more specific prompt.' };
  }

  const citations = _extractCitations(data);
  const statsResult = _extractUsageStats(data);
  const { webSources, xPosts, _source, _debugWebCalls, _debugXCalls } = statsResult;

  // Log debug info for monitoring
  log.debug(`   📊 Research stats [${_source}]: web=${webSources}, x=${xPosts} | calls: ${_debugWebCalls} web, ${_debugXCalls}`);

  const citationsBlock = citations.length > 0
    ? `\nSources:\n${citations.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`
    : '';

  const truncatedAttr = truncated ? ' truncated_prompt="true"' : '';
  return {
    success: true,
    message: `<ResearchReport citations="${citations.length}"${truncatedAttr}>
${text}
${citationsBlock}</ResearchReport>`,
    // Usage stats — accumulated by the dispatcher into responseCtx for the
    // final message badge (e.g. "🌐: 7 sources. 𝕏: 3 posts.").
    _stats: { webSources, xPosts },
  };
}

module.exports = { webXSearch };
