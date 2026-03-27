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
 * Build a Discord structured output schema for Gemini.
 * @param {string} [currentThreadTitle] - Optional current thread title for inline guidance
 * @returns {object} response_format object
 */
function buildDiscordResponseFormat(currentThreadTitle = '') {
  const titleHint = currentThreadTitle
    ? `Nuovo titolo per il thread Discord (titolo corrente: "${currentThreadTitle}"). Lascia vuoto se non serve cambiare il titolo.`
    : 'Nuovo titolo per il thread Discord.';

  return {
    type: 'json_schema',
    json_schema: {
      name: 'discord_response',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: titleHint,
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
}

const DISCORD_RESPONSE_FORMAT = buildDiscordResponseFormat();

module.exports = { callGemini, DISCORD_RESPONSE_FORMAT, buildDiscordResponseFormat };
