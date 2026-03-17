const { API_BASE_URL, GROK_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');

/**
 * Call Grok via AIMLAPI (used for dynamic scheduled tasks).
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions for function calling
 * @returns {Promise<object>} The assistant message from the response
 */
async function callGrok(messages, tools = null) {
  const body = {
    model: GROK_MODEL,
    messages,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) body.tools = tools;

  return callModel('Grok', `${API_BASE_URL}/chat/completions`, body);
}

module.exports = { callGrok };
