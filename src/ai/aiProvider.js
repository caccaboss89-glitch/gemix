// src/ai/aiProvider.js
// Single-provider router: every request goes to Qwen. Audio/video content
// parts (which Qwen can't ingest) are pre-processed through the media
// describer and swapped for `<Description>` text
// parts before the call. This removes the legacy Qwen↔Gemini fork and
// avoids the quality drop of running entire complex tasks on a small
// multimodal model just because the request happens to contain audio.

const { OPENROUTER_API_KEY, AGENTIC_MODEL, FAST_MODEL } = require('../config/env');
const { OPENROUTER_BASE_URL, MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');
const { describeMediaInMessages } = require('./mediaDescriber');

function getQwenModel({ agenticUnlocked = false } = {}) {
  return agenticUnlocked ? AGENTIC_MODEL : FAST_MODEL;
}

/**
 * Call the main AI provider (Qwen) via OpenRouter.
 * Audio/video parts in `messages` are described in one batch call and
 * replaced in-place with `<Description>` text parts before the call.
 * Parts are mutated once so they are not re-described on subsequent rounds.
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {Array|null} tools - Tool definitions array
 * @returns {Promise<{message: object, provider: string, model: string}>}
 */
async function callAI(messages, tools = null, options = {}) {
  const processedMessages = await describeMediaInMessages(messages);
  const model = getQwenModel(options);

  const body = {
    model,
    messages: processedMessages,
    max_tokens: MAX_TOKENS,
    reasoning: { effort: 'high' },
  };
  if (tools && tools.length > 0) body.tools = tools;

  const message = await callModel('Qwen', `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
  return { message, provider: 'Qwen', model };
}

module.exports = { callAI };
