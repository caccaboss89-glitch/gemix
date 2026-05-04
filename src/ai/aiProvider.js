// src/ai/aiProvider.js
// Single-provider router: every request goes to Qwen. Audio/video content
// parts (which Qwen can't ingest) are pre-processed through the media
// describer and swapped for `<Description>` text
// parts before the call. This removes the legacy Qwen↔Gemini fork and
// avoids the quality drop of running entire complex tasks on a small
// multimodal model just because the request happens to contain audio.

const { OPENROUTER_API_KEY, AGENTIC_MODEL, FAST_MODEL, SKILLS_MODEL } = require('../config/env');
const { OPENROUTER_BASE_URL, MAX_TOKENS } = require('../config/constants');
const { callModel } = require('./apiClient');
const { describeMediaInMessages } = require('./mediaDescriber');

function getAIModel({ agenticUnlocked = false, skillsModelActive = false } = {}) {
  if (skillsModelActive && SKILLS_MODEL) {
    return SKILLS_MODEL;
  }
  return agenticUnlocked ? AGENTIC_MODEL : FAST_MODEL;
}

function getReasoningConfig(model) {
  if (!model) return { effort: 'medium' };
  if (model === FAST_MODEL) return { effort: 'medium' };
  if (model === AGENTIC_MODEL) return { effort: 'high' };
  if (/^x-ai\/grok-/i.test(model)) return null;
  return { effort: 'medium' };
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
  const model = getAIModel(options);
  const reasoning = getReasoningConfig(model);

  const body = {
    model,
    messages: processedMessages,
    max_tokens: MAX_TOKENS,
  };
  if (reasoning) body.reasoning = reasoning;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }

  const message = await callModel(model, `${OPENROUTER_BASE_URL}/chat/completions`, body, OPENROUTER_API_KEY);
  return { message, provider: 'OpenRouter', model };
}

module.exports = { callAI };
