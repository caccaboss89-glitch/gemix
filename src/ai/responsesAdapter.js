// src/ai/responsesAdapter.js
//
// Bidirectional adapter between chat-completions style messages and tools
// (used by handler, tools, history) and xAI Responses API wire format
// (`/v1/responses` with `input[]`, `instructions`, flat tools, typed items
// like function_call / function_call_output).

const { XAI_REASONING_REPLAY } = require('../config/env');

/**
 * Convert a single chat-style content payload (string OR array of parts) to
 * an array of Responses-API input parts for a `user` role message.
 */
function _userContentToInputParts(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text') {
      if (typeof part.text === 'string' && part.text.length > 0) {
        out.push({ type: 'input_text', text: part.text });
      }
      continue;
    }

    if (part.type === 'image_url') {
      const url = part.image_url?.url;
      if (typeof url === 'string' && url.length > 0) {
        out.push({ type: 'input_image', image_url: url });
      }
      continue;
    }

    if (part.type === 'input_text' || part.type === 'input_image' || part.type === 'input_file') {
      out.push(part);
    }
  }
  return out;
}

function _assistantContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const pieces = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') pieces.push(part.text);
    else if (part.type === 'output_text' && typeof part.text === 'string') pieces.push(part.text);
  }
  return pieces.join('');
}

function _toolContentToResponsesOutput(content) {
  if (typeof content === 'string') {
    return { output: content, extraUserParts: [] };
  }
  if (!Array.isArray(content)) {
    try {
      return { output: JSON.stringify(content), extraUserParts: [] };
    } catch {
      return { output: String(content ?? ''), extraUserParts: [] };
    }
  }

  const textPieces = [];
  const extraUserParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textPieces.push(part.text);
      continue;
    }
    if (part.type === 'input_file' && typeof part.file_url === 'string') {
      extraUserParts.push({ type: 'input_file', file_url: part.file_url });
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      extraUserParts.push({ type: 'input_image', image_url: part.image_url.url });
    }
  }

  const output = textPieces.length > 0
    ? textPieces.join('\n')
    : JSON.stringify(content);
  return { output, extraUserParts };
}

/** xAI server-side tool output items replayed on the next request (in-order). */
const SERVER_SIDE_OUTPUT_TYPES = new Set([
  'code_interpreter_call',
  'web_search_call',
  'custom_tool_call',
]);

function _cloneOutputItem(item) {
  try {
    return JSON.parse(JSON.stringify(item));
  } catch {
    return item;
  }
}

function _shouldStoreOutputItem(item) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return false;
  if (item.type === 'reasoning') {
    return typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  }
  if (item.type === 'function_call') return Boolean(item.call_id || item.id) && typeof item.name === 'string';
  if (SERVER_SIDE_OUTPUT_TYPES.has(item.type)) return true;
  if (item.type === 'message' && Array.isArray(item.content)) return true;
  return false;
}

function _pushFunctionCallInput(input, item) {
  const callId = item.call_id || item.id;
  if (!callId || typeof item.name !== 'string') return;
  input.push({
    type: 'function_call',
    call_id: callId,
    name: item.name,
    arguments: typeof item.arguments === 'string'
      ? item.arguments
      : JSON.stringify(item.arguments ?? {}),
  });
}

/**
 * Replay a prior Responses API `output[]` slice into the next request `input[]`.
 * Matches xAI docs: spread `response.output` before new user/tool items.
 */
function _replayStoredOutput(input, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!_shouldStoreOutputItem(item)) continue;
    if (item.type === 'function_call') {
      _pushFunctionCallInput(input, item);
    } else {
      input.push(_cloneOutputItem(item));
    }
  }
}

function chatMessagesToResponsesInput(messages) {
  let instructions = '';
  const input = [];

  if (!Array.isArray(messages)) return { instructions, input };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    switch (msg.role) {
      case 'system': {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
        }
        if (text) {
          instructions = instructions ? `${instructions}\n\n${text}` : text;
        }
        break;
      }

      case 'user': {
        const content = _userContentToInputParts(msg.content);
        if (content.length > 0) {
          input.push({ role: 'user', content });
        }
        break;
      }

      case 'assistant': {
        const storedOutput = msg._responsesOutput;
        if (Array.isArray(storedOutput) && storedOutput.length > 0) {
          _replayStoredOutput(input, storedOutput);
          // Rare API shape: visible text only in output_text, not as a message item.
          const hasMessageItem = storedOutput.some((i) => i && i.type === 'message');
          if (!hasMessageItem) {
            const text = _assistantContentToText(msg.content);
            if (text && text.length > 0) {
              input.push({ role: 'assistant', content: text });
            }
          }
        } else {
          const text = _assistantContentToText(msg.content);
          if (text && text.length > 0) {
            input.push({ role: 'assistant', content: text });
          }
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              if (!tc || tc.type !== 'function' || !tc.function) continue;
              input.push({
                type: 'function_call',
                call_id: tc.id,
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments ?? {}),
              });
            }
          }
        }
        break;
      }

      case 'tool': {
        if (!msg.tool_call_id) break;
        const { output, extraUserParts } = _toolContentToResponsesOutput(msg.content);
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output,
        });
        if (extraUserParts.length > 0) {
          input.push({ role: 'user', content: extraUserParts });
        }
        break;
      }

      default:
        break;
    }
  }

  return { instructions, input };
}

function chatToolsToResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' && t.function) {
      const fn = t.function;
      out.push({
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || { type: 'object', properties: {} },
      });
      continue;
    }
    if (typeof t.type === 'string' && t.type !== 'function') {
      out.push(t);
    }
  }
  return out.length > 0 ? out : null;
}

function responsesToAssistantMessage(data) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  const textPieces = [];
  const responsesOutput = [];

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'output_text' && typeof part.text === 'string') {
            textPieces.push(part.text);
          } else if (typeof part.text === 'string' && !part.type) {
            textPieces.push(part.text);
          }
        }
        if (_shouldStoreOutputItem(item)) responsesOutput.push(_cloneOutputItem(item));
        continue;
      }

      if (item.type === 'function_call') {
        const callId = item.call_id || item.id;
        if (!callId || typeof item.name !== 'string') continue;
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
          },
        });
        if (_shouldStoreOutputItem(item)) responsesOutput.push(_cloneOutputItem(item));
        continue;
      }

      if (item.type === 'reasoning') {
        if (XAI_REASONING_REPLAY && _shouldStoreOutputItem(item)) {
          responsesOutput.push(_cloneOutputItem(item));
        }
        continue;
      }

      if (SERVER_SIDE_OUTPUT_TYPES.has(item.type)) {
        responsesOutput.push(_cloneOutputItem(item));
      }
    }
  }

  if (textPieces.length === 0 && typeof data?.output_text === 'string' && data.output_text) {
    textPieces.push(data.output_text);
  }

  message.content = textPieces.join('').trim();
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (responsesOutput.length > 0) {
    message._responsesOutput = responsesOutput;
  }

  return message;
}

// -- Server-side search stats ------------------------------------------------

/** xAI X sub-tools invoked via `custom_tool_call` under the native `x_search` tool. */
const _X_CUSTOM_TOOL_ESTIMATE = {
  x_keyword_search: (input) => _limitFromCustomToolInput(input),
  x_semantic_search: (input) => _limitFromCustomToolInput(input),
  x_user_search: () => 1,
  x_thread_fetch: () => 1,
  view_x_video: () => 1,
};

function _parseCustomToolInput(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _limitFromCustomToolInput(raw) {
  const obj = _parseCustomToolInput(raw);
  if (!obj) return 0;
  const limit = obj.limit;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return Math.floor(limit);
  }
  if (typeof limit === 'string') {
    const n = parseInt(limit, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function _estimateXCustomToolCall(item) {
  const name = item?.name;
  if (typeof name !== 'string') return 0;
  const estimate = _X_CUSTOM_TOOL_ESTIMATE[name];
  return estimate ? estimate(item.input) : 0;
}

/**
 * Server-side search statistics from a Responses API payload for the research
 * badge appended to user-facing replies.
 *
 * Web: sums URLs from each `web_search_call` (`action.sources`) and counts
 * each `open_page` browse as 1.
 *
 * X: estimates from each `custom_tool_call` X sub-tool (x_keyword_search and
 * x_semantic_search use the `limit` in call input; x_user_search,
 * x_thread_fetch, and view_x_video count as 1).
 *
 * @param {object} data - Parsed /v1/responses payload.
 * @returns {{ webSources: number, xPosts: number }}
 */
function extractServerSearchStats(data) {
  let webSources = 0;
  let xPosts = 0;

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'web_search_call') {
        const action = item.action || {};
        if (Array.isArray(action.sources)) webSources += action.sources.length;
        else if (action.type === 'open_page') webSources += 1;
        continue;
      }
      if (item.type === 'custom_tool_call') {
        xPosts += _estimateXCustomToolCall(item);
      }
    }
  }

  return { webSources, xPosts };
}

module.exports = {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats,
};