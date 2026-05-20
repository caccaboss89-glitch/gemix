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
const { createLogger } = require('../utils/logger');

const log = createLogger('WebXSearch');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

// SuperGrok plan only allows the 4-agent (low effort) tier.
// Hardcoded here so the main model can't accidentally request the unsupported tier.
const FIXED_EFFORT = 'low';

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
 * Extract research usage stats from the xAI Responses API payload.
 * Uses the documented `usage.num_sources_used` (web sources) and
 * `usage.server_side_tool_usage_details.x_search_calls` (X/Twitter posts).
 *
 * @param {object} data - Parsed JSON response body
 * @returns {{ webSources: number, xPosts: number }}
 */
function _extractUsageStats(data) {
  const usage = (data && typeof data === 'object') ? (data.usage || {}) : {};
  const details = (usage.server_side_tool_usage_details && typeof usage.server_side_tool_usage_details === 'object')
    ? usage.server_side_tool_usage_details
    : {};

  // num_sources_used is the most reliable count (web + browse).
  // Fall back to web_search_calls if the field is absent.
  const webSources = Number(usage.num_sources_used ?? details.web_search_calls ?? 0) || 0;
  const xPosts = Number(details.x_search_calls ?? 0) || 0;

  return { webSources, xPosts };
}

/**
 * Hit POST /v1/responses with retry/timeout, returning the parsed JSON body.
 * Errors are logged and re-thrown after notifying the admin on the final attempt.
 */
async function _callMultiAgent(prompt) {
  const body = {
    model: MULTI_AGENT_MODEL,
    reasoning: { effort: FIXED_EFFORT },
    input: [{ role: 'user', content: prompt }],
    tools: [
      { type: 'web_search' },
      { type: 'x_search' },
    ],
  };

  logApiRequest(MULTI_AGENT_MODEL, RESPONSES_URL, body);

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
  const { webSources, xPosts } = _extractUsageStats(data);

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
