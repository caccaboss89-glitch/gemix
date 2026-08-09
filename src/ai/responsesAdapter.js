// src/ai/responsesAdapter.js
//
// Bidirectional adapter between chat-completions style messages and tools
// (used by handler, tools, history) and xAI Responses API wire format
// (`/v1/responses` with `input[]`, flat tools, typed items like
// function_call / function_call_output). Static system lives in input[0].

import { XAI_REASONING_REPLAY  } from '../config/env.js';

/** Strip internal-only fields before sending parts to xAI. */
function _toWireUserPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'input_text' && typeof part.text === 'string' && part.text.length > 0) {
    return { type: 'input_text', text: part.text };
  }
  if (part.type === 'input_file' && typeof part.file_url === 'string') {
    return { type: 'input_file', file_url: part.file_url };
  }
  if (part.type === 'input_image' && typeof part.image_url === 'string') {
    return { type: 'input_image', image_url: part.image_url };
  }
  if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
    return { type: 'input_image', image_url: part.image_url.url };
  }
  return null;
}

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
      const wire = _toWireUserPart(part);
      if (wire) out.push(wire);
      continue;
    }

    if (part.type === 'input_text' || part.type === 'input_image' || part.type === 'input_file') {
      const wire = _toWireUserPart(part);
      if (wire) out.push(wire);
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

  // Tools that hand files to the model put the JSON envelope in a leading text
  // part and then label/file pairs ("[web_image_search IMAGE_0]", the preview,
  // "[…IMAGE_1]", …). Forward that tail verbatim so every label stays next to
  // the file it names; folding all the text into the output would leave the
  // files unlabeled and only positionally identifiable.
  const head = content[0];
  if (head && head.type === 'text' && typeof head.text === 'string') {
    return {
      output: head.text,
      extraUserParts: _userContentToInputParts(content.slice(1))
    };
  }

  // No envelope: keep every text in the output and send the files after it.
  const textPieces = [];
  const extraUserParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textPieces.push(part.text);
      continue;
    }
    const wire = _toWireUserPart(part);
    if (wire) extraUserParts.push(wire);
  }

  const output = textPieces.length > 0
    ? textPieces.join('\n')
    : JSON.stringify(content);
  return { output, extraUserParts };
}

/** xAI server-side tool output items replayed on the next request (in-order). */
const SERVER_SIDE_OUTPUT_TYPES = new Set([
  'web_search_call',
  'custom_tool_call'
]);

function _cloneOutputItem(item) {
  try {
    return JSON.parse(JSON.stringify(item));
  } catch {
    return item;
  }
}

/**
 * Shape a stored reasoning item for the next request `input[]`.
 * Grok Build repo: pass summary, content, encrypted_content, id — but
 * `status` is output-only and the API rejects it on input.
 */
function _reasoningItemForInput(item) {
  const out = _cloneOutputItem(item);
  if (out && typeof out === 'object') {
    delete out.status;
  }
  return out;
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
  // Omit output-only fields (status, server id) — same as Grok Build repo.
  input.push({
    type: 'function_call',
    call_id: callId,
    name: item.name,
    arguments: typeof item.arguments === 'string'
      ? item.arguments
      : JSON.stringify(item.arguments ?? {})
  });
}

/**
 * Replay a prior Responses API `output[]` slice into the next request `input[]`.
 * Matches xAI docs: spread `response.output` before new user/tool items.
 * Reasoning is kept (encrypted_content + summary) so the model continues the
 * same chain-of-thought; only wire-illegal output fields are stripped.
 */
function _replayStoredOutput(input, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!_shouldStoreOutputItem(item)) continue;
    if (item.type === 'function_call') {
      _pushFunctionCallInput(input, item);
    } else if (item.type === 'reasoning') {
      input.push(_reasoningItemForInput(item));
    } else {
      input.push(_cloneOutputItem(item));
    }
  }
}

/**
 * Convert chat-style messages to Responses `input[]`.
 *
 * `role: system` items stay in input[] order (static prefix should be first
 * and alone — a second system after history is folded by xAI and busts
 * progressive cache). The Runtime block is role:user. Do not put the static
 * system only in top-level `instructions` (not part of the message prefix).
 *
 * @param {Array} messages
 * @param {{ instructions?: string }} [opts] - Optional top-level instructions
 *   (unused by the main brain; kept for callers that still set it).
 * @returns {{ instructions: string, input: Array }}
 */
function chatMessagesToResponsesInput(messages, opts = {}) {
  const instructions = typeof opts.instructions === 'string' ? opts.instructions : '';
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
          .filter(p => p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string')
          .map(p => p.text)
          .join('\n');
      }
      if (text) {
        // Keep system items in input[] order (prefer a single static head).
        input.push({ role: 'system', content: text });
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
                : JSON.stringify(tc.function.arguments ?? {})
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
        output
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
        parameters: fn.parameters || { type: 'object', properties: {} }
      });
      continue;
    }
    if (typeof t.type === 'string' && t.type !== 'function') {
      out.push(t);
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Pick the user-facing assistant text from one or more message items.
 *
 * With server-side tools the agentic loop narrates itself: xAI emits a `message`
 * item per step, each a complete structured reply, and only the last one is the
 * answer. Verified by probe — one run produced 16 of them across 29 server-side
 * calls ("Sto recuperando il post…", "Riprovo in un altro modo.", … then the
 * real reply). Joining them would break the structured JSON, so prefer the last
 * piece that parses as a reply, else the last non-empty message text.
 *
 * @param {string[]} messageTexts - One string per output message item (parts already joined).
 * @returns {string}
 */
function _pickAssistantText(messageTexts) {
  if (!Array.isArray(messageTexts) || messageTexts.length === 0) return '';
  if (messageTexts.length === 1) return messageTexts[0];

  for (let i = messageTexts.length - 1; i >= 0; i--) {
    const raw = messageTexts[i];
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) continue;
    try {
      const p = JSON.parse(t);
      if (
        p && typeof p === 'object' && !Array.isArray(p)
        && (typeof p.response === 'string' || typeof p.message === 'string')
      ) {
        return raw;
      }
    } catch { /* try earlier piece */ }
  }

  for (let i = messageTexts.length - 1; i >= 0; i--) {
    if (typeof messageTexts[i] === 'string' && messageTexts[i].trim()) {
      return messageTexts[i];
    }
  }
  return messageTexts[messageTexts.length - 1] || '';
}

function responsesToAssistantMessage(data) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  // One entry per output `message` item (content parts joined within the item).
  const messageTexts = [];
  const responsesOutput = [];

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'message' && Array.isArray(item.content)) {
        const parts = [];
        for (const part of item.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'output_text' && typeof part.text === 'string') {
            parts.push(part.text);
          } else if (typeof part.text === 'string' && !part.type) {
            parts.push(part.text);
          }
        }
        const text = parts.join('');
        if (text.trim()) messageTexts.push(text);
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
              : JSON.stringify(item.arguments ?? {})
          }
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

  if (messageTexts.length === 0 && typeof data?.output_text === 'string' && data.output_text) {
    messageTexts.push(data.output_text);
  }

  message.content = _pickAssistantText(messageTexts).trim();
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
  view_x_video: () => 1
};

function _parseCustomToolInput(raw) {
  if (raw === null || raw === undefined) return null;
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

export {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats

};