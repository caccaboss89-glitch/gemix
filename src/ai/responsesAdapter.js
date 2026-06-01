// src/ai/responsesAdapter.js
//
// Bidirectional adapter between chat-completions style messages and tools
// (used by handler, tools, history) and xAI Responses API wire format
// (`/v1/responses` with `input[]`, `instructions`, flat tools, typed items
// like function_call / function_call_output).
//
// All three exported functions are pure and heavily used by aiProvider + buildAgent.

/**
 * Convert a single chat-style content payload (string OR array of parts) to
 * an array of Responses-API input parts for a `user` role message.
 *
 * Mappings:
 *   - chat `text`        -> responses `input_text`
 *   - chat `image_url`   -> responses `input_image` (image_url is the data/https URL)
 *   - Responses-format parts (`input_text`, `input_image`, `input_file`) pass through
 *
 * Empty/falsy parts are dropped. The function never throws on unknown shapes:
 * unknown parts are silently skipped so a malformed entry does not blow up the
 * whole call (the model would just see a slightly shorter message).
 *
 * @param {string|Array} content
 * @returns {Array}
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

    // Pass through native responses parts (e.g. {type:'input_file', file_url:'https://...'} for attachments).
    if (part.type === 'input_text' || part.type === 'input_image' || part.type === 'input_file') {
      out.push(part);
      continue;
    }
    // Unknown shapes: silently skip rather than break the call.
  }
  return out;
}

/**
 * Reduce an assistant content payload (string or array of text parts) to a
 * plain string. Responses API accepts both `string` and `[{type:'output_text'}]`
 * for assistant input items; the function normalizes to string for simplicity.
 */
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

/**
 * Stringify a `tool` message content for Responses' function_call_output.output.
 * Tool results are typically JSON strings; arrays are returned by the
 * multimodal image_search/read_file paths and require stable serialization here.
 *
 * `output` on `function_call_output` is required to be a string.
 */
function _toolOutputToString(content) {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? '');
  }
}

/**
 * Translate a chat-completions `messages[]` array into the equivalent
 * Responses API `{ instructions, input }` pair.
 *
 * Rules:
 *   - `system` messages are concatenated (in order) into `instructions`.
 *     Multi-system messages are supported by the handler (round hint reinjection);
 *     they merge here with `\n\n`.
 *   - `user` messages produce a `message` item with content parts.
 *     User messages with no usable parts are dropped.
 *   - `assistant` messages produce up to one `message` item (when there is
 *     visible text content) plus one `function_call` item per `tool_calls[]`
 *     entry. The chat-style `tool_call.id` becomes the `call_id` on the
 *     responses-side function_call (the wire field used to match results).
 *   - `tool` messages become `function_call_output` items. The chat-style
 *     `tool_call_id` becomes the responses `call_id`.
 *
 * No reasoning items are emitted. GemiX does not store reasoning blobs
 * across rounds in the provided messages.
 *
 * @param {Array} messages
 * @returns {{ instructions: string, input: Array }}
 */
function chatMessagesToResponsesInput(messages) {
  let instructions = '';
  const input = [];

  if (!Array.isArray(messages)) return { instructions, input };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    switch (msg.role) {
      case 'system': {
        // Pull plain text out of the system message regardless of shape.
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
        break;
      }

      case 'tool': {
        if (!msg.tool_call_id) break;
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: _toolOutputToString(msg.content),
        });
        break;
      }

      default:
        // Unknown roles (e.g. developer) are dropped silently.
        break;
    }
  }

  return { instructions, input };
}

/**
 * Translate a chat-completions `tools[]` array into Responses API tools.
 *
 * Two shapes are supported:
 *   1. Chat-style function tool:
 *        { type:'function', function:{ name, description, parameters } }
 *      -> flattened to: { type:'function', name, description, parameters }
 *   2. Native xAI server-side tool (in Responses shape):
 *        { type:'code_interpreter' } | { type:'web_search' } | { type:'x_search', limit:N } | ...
 *      -> passed through unchanged.
 *
 * The pass-through allows getToolsForUser() to mix function tools and
 * server-side tools in the same `tools[]` array; xAI executes server-side
 * tools transparently without consuming a round of the outer loop.
 *
 * Returns null when the input is empty/missing so the caller can omit the
 * key entirely (xAI rejects an empty array on some endpoints).
 *
 * @param {Array} tools
 * @returns {Array|null}
 */
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
    // Native server-side tool (in Responses shape): passed through unchanged.
    if (typeof t.type === 'string' && t.type !== 'function') {
      out.push(t);
      continue;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Translate a `/v1/responses` response payload into the chat-completions
 * assistant message shape the rest of GemiX consumes.
 *
 * Output shape:
 *   {
 *     role: 'assistant',
 *     content: <plain text concatenation of all output_text parts>,
 *     tool_calls?: [
 *       { id: <call_id>, type: 'function', function: { name, arguments } },
 *       ...
 *     ],
 *   }
 *
 * Notes:
 *   - The responses `call_id` is used as the chat-style `id`. This value is
 *     round-tripped back into the next call's `function_call_output.call_id`,
 *     so keeping `id === call_id` in the internal shape avoids a parallel
 *     mapping.
 *   - Reasoning items are ignored at this layer (the handler does not use
 *     them and they are not echoed back to the model).
 *   - When the model produces no text and no tool_calls (rare, but happens
 *     on safety refusals), the returned `content` is the empty string and
 *     `tool_calls` is omitted; downstream callers handle that case.
 *
 * @param {object} data - Parsed JSON body from /v1/responses
 * @returns {object}
 */
function responsesToAssistantMessage(data) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  const textPieces = [];

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'output_text' && typeof part.text === 'string') {
            textPieces.push(part.text);
          } else if (typeof part.text === 'string' && !part.type) {
            // Defensive: some shapes return bare {text:'...'} parts.
            textPieces.push(part.text);
          }
        }
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
        continue;
      }

      // Reasoning, web_search_call, custom_tool_call, etc.: not part of the
      // chat-completion message contract - silently skipped.
    }
  }

  // Convenience field that some xAI responses emit at the top level.
  if (textPieces.length === 0 && typeof data?.output_text === 'string' && data.output_text) {
    textPieces.push(data.output_text);
  }

  message.content = textPieces.join('').trim();
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return message;
}

module.exports = {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
};
