// src/tools/webXSearch.js
//
// Single research tool: delegates to xAI's grok-4.20-multi-agent via Hermes proxy.
// The team performs web_search and x_search server-side and returns a synthesized
// answer with citations. Sub-agent tool calls are encrypted by Hermes, so result
// counts for those are estimated from the orchestrator's visible activity.

const { HERMES_API_KEY, HERMES_BASE_URL, MULTI_AGENT_MODEL } = require('../config/env');
const { logApiRequest, logApiResponse } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { getRomeTime } = require('../utils/time');
const { createLogger } = require('../utils/logger');

const log = createLogger('WebXSearch');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;
const FIXED_EFFORT = 'high';
const WEB_NUM_RESULTS = 10;
const X_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_PROMPT_LEN = 4000;

function _extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return null;

  const texts = [];
  for (const item of data.output) {
    if (typeof item?.text === 'string' && item.text.trim()) {
      texts.push(item.text.trim());
      continue;
    }
    if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        } else if (typeof part?.text?.value === 'string' && part.text.value.trim()) {
          texts.push(part.text.value.trim());
        }
      }
    }
  }
  return texts.length > 0 ? texts.join('\n\n').trim() : null;
}

/**
 * Collect deduplicated citation URLs for the "Sources" block of the report.
 * Pulls from message annotations (url_citation), output[].citations and
 * top-level data.citations. Used only for the textual list shown to the
 * caller, NOT for the result-count stats.
 */
function _extractCitations(data) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const url = typeof raw === 'string' ? raw : raw?.url || raw?.uri;
    if (typeof url !== 'string') return;
    const key = url.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  if (Array.isArray(data?.citations)) data.citations.forEach(push);
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (Array.isArray(item?.citations)) item.citations.forEach(push);
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (Array.isArray(part?.annotations)) {
            for (const ann of part.annotations) push(ann?.url || ann?.uri);
          }
          if (Array.isArray(part?.citations)) part.citations.forEach(push);
        }
      }
    }
  }
  return out;
}

/**
 * Estimate the total number of web results and X posts the team gathered.
 *
 * Hermes encrypts sub-agent tool activity, so only the orchestrator's calls
 * are visible in `output[]`. To approximate the figure the official Grok
 * surface shows (sub-agents decrypted), we:
 *   1. Count exact results from every visible web_search_call and X
 *      custom_tool_call (no dedup — duplicates count).
 *   2. Compute the empirical average results-per-call from the visible data.
 *   3. Multiply that average by the number of *encrypted* sub-agent calls,
 *      derived from `usage.server_side_tool_usage_details`.
 *   4. Sum visible + encrypted estimate.
 *
 * If the visible orchestrator made zero calls of a given type (rare), fall
 * back to the configured per-call limit as the average.
 */
function _estimateResultCounts(data) {
  let visibleWebCalls = 0;
  let visibleWebResults = 0;
  let visibleXCalls = 0;
  let visibleXResults = 0;

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item) continue;

      if (item.type === 'web_search_call' && item.action) {
        visibleWebCalls++;
        if (item.action.type === 'search' && Array.isArray(item.action.sources)) {
          visibleWebResults += item.action.sources.length;
        } else if (item.action.type === 'open_page' && item.action.url) {
          visibleWebResults += 1;
        }
      }

      if (item.type === 'custom_tool_call' && /^x_/i.test(item.name || '')) {
        visibleXCalls++;
        let perCall = X_LIMIT;
        if (typeof item.input === 'string') {
          try {
            const obj = JSON.parse(item.input);
            const n = Number(obj?.limit);
            if (Number.isFinite(n) && n > 0) perCall = n;
          } catch { /* not JSON */ }
        }
        visibleXResults += perCall;
      }
    }
  }

  const details = data?.usage?.server_side_tool_usage_details || {};
  const totalWebCalls = Math.max(Number(details.web_search_calls) || 0, visibleWebCalls);
  const totalXCalls = Math.max(Number(details.x_search_calls) || 0, visibleXCalls);

  const avgWebPerCall = visibleWebCalls > 0
    ? visibleWebResults / visibleWebCalls
    : WEB_NUM_RESULTS;
  const avgXPerCall = visibleXCalls > 0
    ? visibleXResults / visibleXCalls
    : X_LIMIT;

  const encryptedWebCalls = Math.max(0, totalWebCalls - visibleWebCalls);
  const encryptedXCalls = Math.max(0, totalXCalls - visibleXCalls);

  const webSources = visibleWebResults + Math.round(avgWebPerCall * encryptedWebCalls);
  const xPosts = visibleXResults + Math.round(avgXPerCall * encryptedXCalls);

  return {
    webSources,
    xPosts,
    _debug: {
      visibleWeb: `${visibleWebCalls} calls / ${visibleWebResults} results (avg ${avgWebPerCall.toFixed(1)})`,
      visibleX: `${visibleXCalls} calls / ${visibleXResults} results (avg ${avgXPerCall.toFixed(1)})`,
      totalWebCalls,
      totalXCalls,
      encryptedWebCalls,
      encryptedXCalls,
    },
  };
}

async function _callMultiAgent(prompt) {
  const contextBlock = `[Context]\nCurrent date and time (Europe/Rome): ${getRomeTime()}\n[/Context]\n\n[Research brief]\n${prompt}`;

  const body = {
    model: MULTI_AGENT_MODEL,
    reasoning: { effort: FIXED_EFFORT },
    input: [{ role: 'user', content: contextBlock }],
    tools: [
      { type: 'web_search', num_results: WEB_NUM_RESULTS },
      { type: 'x_search', limit: X_LIMIT },
    ],
  };

  logApiRequest(MULTI_AGENT_MODEL, RESPONSES_URL, body);
  log.info(`   📡 → ${MULTI_AGENT_MODEL} (input: ${contextBlock.length} chars)`);

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
    try { logApiResponse(MULTI_AGENT_MODEL, RESPONSES_URL, data); } catch { /* best effort */ }
    log.info(`   ✅ multi-agent reply in ${Date.now() - startTime}ms`);
    return data;

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    const msg = isTimeout ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : err.message;
    log.error(`   ❌ multi-agent error: ${msg}`);
    await notifyAdmin('WebXSearch (multi-agent)', `Error: ${msg}`);
    throw new Error(`Research team unavailable: ${msg}${ADMIN_NOTIFIED_SUFFIX}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand a research brief to the grok-4.20-multi-agent team.
 * @param {string} prompt
 * @returns {Promise<{success: boolean, message?: string, error?: string, _stats?: {webSources: number, xPosts: number}}>}
 */
async function webXSearch(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return {
      success: false,
      error: 'Missing "prompt": describe what to research, including any specific URLs or domains to inspect.',
    };
  }

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
  const { webSources, xPosts, _debug } = _estimateResultCounts(data);

  log.debug(`   📊 Estimated results: web=${webSources}, x=${xPosts} | visible web: ${_debug.visibleWeb}, visible x: ${_debug.visibleX} | total calls: ${_debug.totalWebCalls} web / ${_debug.totalXCalls} x`);

  const citationsBlock = citations.length > 0
    ? `\nSources:\n${citations.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`
    : '';

  const truncatedAttr = truncated ? ' truncated_prompt="true"' : '';
  return {
    success: true,
    message: `<ResearchReport citations="${citations.length}"${truncatedAttr}>
${text}
${citationsBlock}</ResearchReport>`,
    _stats: { webSources, xPosts },
  };
}

module.exports = { webXSearch };
