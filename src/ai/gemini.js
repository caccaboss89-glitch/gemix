const { API_BASE_URL, GEMINI_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');

/**
 * Call Gemini via AIMLAPI (OpenAI-compatible) with automatic retry and timeout.
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions array
 * @param {object|null} responseFormat - Optional response_format for structured output
 * @returns {Promise<object>} The assistant message from the response
 */
async function callGemini(messages, tools = null, responseFormat = null) {
  const body = {
    model: GEMINI_MODEL,
    messages,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

  return callModel('Gemini', `${API_BASE_URL}/chat/completions`, body);
}

/**
 * Discord structured output schema for Gemini.
 * Returns { title: string, message: string }.
 */
const DISCORD_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'discord_response',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Nuovo titolo per il thread Discord se quello attuale non è coerente con la conversazione, altrimenti stringa vuota',
        },
        message: {
          type: 'string',
          description: 'Il messaggio di risposta',
        },
      },
      required: ['title', 'message'],
      additionalProperties: false,
    },
  },
};

module.exports = { callGemini, DISCORD_RESPONSE_FORMAT };
