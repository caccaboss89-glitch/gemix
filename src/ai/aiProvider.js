// src/ai/aiProvider.js
//
// Single entry-point for every main-brain LLM call in GemiX. Talks to the
// Hermes Agent proxy (http://127.0.0.1:8000/v1) using the xAI **Responses**
// endpoint (`/v1/responses`) — the same endpoint already used by the
// multi-agent research team (see tools/webXSearch.js).
//
// Why /v1/responses (and not /v1/chat/completions anymore):
//   - It is the only endpoint that reliably accepts native multimodal
//     attachments via `input_file` with public URLs (PDF, audio, video).
//     /v1/chat/completions returns "Empty content block" on most of those.
//   - It is the same surface used internally by xAI's own tools, so we get
//     consistent behaviour and feature parity (function calling, server-side
//     tools like web_search/x_search, code_interpreter on the same path).
//
// What this module does:
//   1. Accepts the same chat-style `messages[]` and `tools[]` it always
//      accepted, so handler.js / tools/index.js don't need to know about
//      the wire change.
//   2. Translates them via responsesAdapter to the Responses API shape:
//      `{ instructions, input, tools, … }`.
//   3. Sends the request through callResponsesModel (apiClient).
//   4. Translates the response back into a chat-completion-shaped assistant
//      message so the caller keeps consuming `{role:'assistant', content,
//      tool_calls}` exactly as before.
//
// Anything that previously worked (text-only chat, function calling, image
// content parts) keeps working unchanged. PDF/audio/video parts are now
// rewritten into Responses-shape `input_file` URL parts by the
// `inputFileBuilder` pre-pass (see src/utils/inputFileBuilder.js); xAI
// fetches them server-side and runs OCR/STT/frame extraction natively.

const { HERMES_API_KEY, HERMES_BASE_URL, GROK_MODEL } = require('../config/env');
const { MAX_TOKENS } = require('../config/constants');
const { callResponsesModel } = require('./apiClient');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
} = require('./responsesAdapter');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

/**
 * Call Grok via the Hermes proxy on the Responses endpoint.
 * @param {Array} messages - Chat-completion-format messages array (string or array
 *   content; tool_calls/tool_call_id supported). Adapter handles translation.
 * @param {Array|null} tools - Chat-completion tool definitions. Adapter flattens
 *   them into Responses-shape function tools; native server-side tools
 *   (e.g. {type:'code_interpreter'}) pass through unchanged.
 * @returns {Promise<{message: object, provider: string, model: string}>}
 */
async function callAI(messages, tools = null) {
  const { instructions, input } = chatMessagesToResponsesInput(messages);

  const body = {
    model: GROK_MODEL,
    input,
    // max_output_tokens is the Responses API counterpart of max_tokens.
    max_output_tokens: MAX_TOKENS,
  };

  // Only attach instructions when we actually have a system prompt; xAI tolerates
  // an empty string but the omission is a touch cleaner in the request log.
  if (instructions && instructions.length > 0) {
    body.instructions = instructions;
  }

  const adaptedTools = chatToolsToResponsesTools(tools);
  if (adaptedTools) {
    body.tools = adaptedTools;
    // Default tool_choice ("auto") matches the previous behaviour of
    // /chat/completions when no explicit choice was sent.
    body.tool_choice = 'auto';
  }

  const data = await callResponsesModel('Grok', RESPONSES_URL, body, HERMES_API_KEY);
  const message = responsesToAssistantMessage(data);
  return { message, provider: 'Grok', model: GROK_MODEL };
}

module.exports = { callAI };
