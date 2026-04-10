const { OPENROUTER_BASE_URL, OPENROUTER_API_KEY, GEMINI_MODEL, QWEN_MODEL } = require('../config/env');
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
 * Call the appropriate AI provider via OpenRouter based on message content.
 * Routes to Gemini when audio is detected, Qwen otherwise.
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions array
 * @returns {Promise<{message: object, provider: string, model: string}>} The assistant message with provider info
 */
async function callAI(messages, tools = null) {
  const useGemini = hasAudioContent(messages);
  const model = useGemini ? GEMINI_MODEL : QWEN_MODEL;
  const provider = useGemini ? 'Gemini' : 'Qwen';

  const body = {
    model,
    messages,
    max_tokens: MAX_TOKENS,
  };
  if (!useGemini) body.reasoning = { effort: 'high' };
  if (tools && tools.length > 0) body.tools = tools;

  const message = await callModel(provider, `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
  return { message, provider, model };
}

module.exports = { callAI, hasAudioContent };
