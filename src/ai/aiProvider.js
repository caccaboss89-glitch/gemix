const { API_BASE_URL, GEMINI_MODEL, API_KEY, OPENROUTER_BASE_URL, OPENROUTER_API_KEY, QWEN_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');

/**
 * Check if any message in the array contains audio content (data:audio/* base64 parts).
 * Used to route requests to Gemini (audio-capable) vs Qwen (text/image only).
 * @param {Array} messages - OpenAI-format messages array
 * @returns {boolean} True if audio content is detected
 */
function hasAudioContent(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        const match = /^data:([^;]+);base64,/.exec(part.image_url.url);
        if (match && match[1].startsWith('audio/')) return true;
      }
    }
  }
  return false;
}

/**
 * Call the appropriate AI provider based on message content.
 * Routes to Gemini (via AIMLAPI) when audio is present, Qwen (via OpenRouter) otherwise.
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions array
 * @param {object|null} responseFormat - Optional response_format for structured output
 * @returns {Promise<{message: object, provider: string, model: string}>} The assistant message with provider info
 */
async function callAI(messages, tools = null, responseFormat = null) {
  // Forza Gemini se: è presente audio nei messaggi OPPURE è richiesto structured output (Discord).
  // Qwen non supporta response_format JSON schema.
  const useGemini = hasAudioContent(messages) || responseFormat !== null;
  const model = useGemini ? GEMINI_MODEL : QWEN_MODEL;
  const baseUrl = useGemini ? API_BASE_URL : OPENROUTER_BASE_URL;
  const apiKey = useGemini ? API_KEY : OPENROUTER_API_KEY;
  const provider = useGemini ? 'Gemini' : 'Qwen';

  const body = {
    model,
    messages,
    max_tokens: MAX_TOKENS,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

  const message = await callModel(provider, `${baseUrl}/chat/completions`, body, apiKey);
  return { message, provider, model };
}

/**
 * Build a Discord structured output schema.
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

module.exports = { callAI, buildDiscordResponseFormat, hasAudioContent };
