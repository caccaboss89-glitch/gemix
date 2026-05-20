// src/tools/codeInterpreter.js
//
// Delegates Python execution to xAI's server-side code_interpreter via
// POST {HERMES_BASE_URL}/responses. The sandbox is managed entirely by xAI
// and has no access to /workspace/ or /readonly/.
//
// Use for: ad-hoc calculations, symbolic math, quick data analysis.
// For project files use write_file + bash instead.

const { HERMES_API_KEY, HERMES_BASE_URL, GROK_MODEL } = require('../config/env');
const { logApiRequest, logApiResponse } = require('../ai/apiClient');
const { notifyAdmin, ADMIN_NOTIFIED_SUFFIX } = require('../utils/adminNotifier');
const { createLogger } = require('../utils/logger');

const log = createLogger('CodeInterpreter');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

// code_interpreter runs synchronously inside xAI; typical latency is 5-30s.
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const MAX_CODE_LEN = 20_000;

// ── Response parsing ────────────────────────────────────────────────────────

/**
 * Extract the text output from an xAI Responses API payload.
 * Tries output_text first, then walks output[].content[].text.
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

// ── Caller ──────────────────────────────────────────────────────────────────

async function _callResponses(code) {
  const body = {
    model: GROK_MODEL,
    input: [{ role: 'user', content: code }],
    tools: [{ type: 'code_interpreter' }],
  };

  logApiRequest(`${GROK_MODEL}/code_interpreter`, RESPONSES_URL, body);

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
      try { logApiResponse(`${GROK_MODEL}/code_interpreter`, RESPONSES_URL, data); } catch { /* best effort */ }
      log.info(`   ✅ code_interpreter reply in ${duration}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return data;

    } catch (err) {
      lastErr = err;
      const isTimeout = err.name === 'AbortError';
      const msg = isTimeout ? `Timeout (${REQUEST_TIMEOUT_MS / 1000}s)` : err.message;
      const isRetryable = isTimeout
        || /HTTP (429|5\d{2})/.test(err.message || '')
        || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(err.message || '');

      if (isRetryable && attempt < MAX_ATTEMPTS) {
        const delay = attempt * 3000;
        log.warn(`   ⚠️ code_interpreter attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg} — retry in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      log.error(`   ❌ code_interpreter error: ${msg}`);
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  await notifyAdmin('CodeInterpreter', `Error after ${MAX_ATTEMPTS} attempt(s): ${lastErr?.message || 'unknown'}`);
  throw new Error(`code_interpreter unavailable: ${lastErr?.message || 'unknown error'}${ADMIN_NOTIFIED_SUFFIX}`);
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Execute Python code via xAI's server-side code_interpreter.
 *
 * @param {string} code - Python code to execute.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function codeInterpreter(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { success: false, error: 'Missing "code" argument.' };
  }

  if (!HERMES_API_KEY) {
    return { success: false, error: 'HERMES_API_KEY is not configured.' };
  }
  if (!GROK_MODEL) {
    return { success: false, error: 'GROK_MODEL is not configured.' };
  }

  let cleanCode = code
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();

  let truncated = false;
  if (cleanCode.length > MAX_CODE_LEN) {
    cleanCode = cleanCode.substring(0, MAX_CODE_LEN);
    truncated = true;
  }

  log.info(`🐍 code_interpreter (${cleanCode.length} chars${truncated ? ', truncated' : ''})`);

  let data;
  try {
    data = await _callResponses(cleanCode);
  } catch (err) {
    return { success: false, error: err.message };
  }

  const text = _extractOutputText(data);
  if (!text) {
    return { success: false, error: 'code_interpreter returned an empty response.' };
  }

  return {
    success: true,
    message: truncated
      ? `[Code was truncated to ${MAX_CODE_LEN} chars]\n\n${text}`
      : text,
  };
}

module.exports = { codeInterpreter };
