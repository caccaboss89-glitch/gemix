// src/ai/aiProvider.js
//
// Single entry-point for every LLM call in GemiX. Talks to the Hermes Agent
// proxy (http://127.0.0.1:8000/v1) which is OpenAI-compatible and forwards
// requests to xAI Grok using a SuperGrok OAuth token managed by the proxy.
//
// Why a single function:
//   - one transport, one retry policy, one log file format,
//   - audio/video/image content parts go through unchanged: Grok ingests
//     them natively (no more pre-pass with a separate captioning model).
//
// FAST vs AGENTIC: same model on Hermes/Grok. The `agenticUnlocked` flag
// only changes the *tool list* and the *system prompt briefing* (handled
// upstream by the handler/system prompt), it does NOT swap the model.

const { HERMES_API_KEY, HERMES_BASE_URL, GROK_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');

/**
 * Call Grok via the Hermes proxy.
 * @param {Array} messages - OpenAI-format messages array (text + multimodal parts)
 * @param {Array|null} tools - OpenAI tool definitions (function calling)
 * @param {object} [options]
 * @param {boolean} [options.agenticUnlocked] - kept for parity with the handler;
 *   it does not change the model anymore but is forwarded to the log so we
 *   can correlate request mode vs. behaviour during the migration.
 * @returns {Promise<{message: object, provider: string, model: string}>}
 */
async function callAI(messages, tools = null, options = {}) {
  const body = {
    model: GROK_MODEL,
    messages,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const apiUrl = `${HERMES_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const message = await callModel('Grok', apiUrl, body, HERMES_API_KEY);
  return { message, provider: 'Grok', model: GROK_MODEL };
}

module.exports = { callAI };
