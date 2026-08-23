// src/ai/responsesAdapter.js
//
// PHASE 8 BRIDGE. Turns the handler's remaining chat-style messages
// (`{role, content}`, `{role:'tool', tool_call_id}`, `assistant.tool_calls`)
// into the Responses-native items the transport speaks.
//
// GemiX's target representation is Responses-native end to end (spec §18.2), so
// this file has no policy left in it: no provider classifiers, no replay
// allowlist, no wire sanitizing. Those moved to ai/transport/responsesProtocol.js
// (generic) and ai/extensions/* (provider-specific). What remains is one
// mechanical translation, and it disappears when the handler and the history
// builders emit items directly.

/** One chat-style content payload to Responses input parts. */
function _contentToInputParts(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      out.push({ type: 'input_text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
      out.push({ type: 'input_image', image_url: part.image_url.url });
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
  return content
    .filter(p => p && typeof p.text === 'string')
    .map(p => p.text)
    .join('');
}

/**
 * Split a tool result into the string a `function_call_output` accepts plus the
 * parts that have to travel separately.
 *
 * Tools that hand files to the model put the JSON envelope in a leading text
 * part and then label/file pairs ("[web_image_search IMAGE_0]", the preview, …).
 * That tail is forwarded verbatim so every label stays next to the file it
 * names; folding all the text into the output would leave the files unlabeled.
 *
 * @param {string|Array|object} content
 * @returns {{ output: string, extraParts: object[] }}
 */
function toolContentToOutput(content) {
  if (typeof content === 'string') return { output: content, extraParts: [] };
  if (!Array.isArray(content)) {
    try {
      return { output: JSON.stringify(content), extraParts: [] };
    } catch {
      return { output: String(content ?? ''), extraParts: [] };
    }
  }

  const head = content[0];
  if (head && head.type === 'text' && typeof head.text === 'string') {
    return { output: head.text, extraParts: _contentToInputParts(content.slice(1)) };
  }

  const textPieces = [];
  const extraParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      textPieces.push(part.text);
      continue;
    }
    const [wire] = _contentToInputParts([part]);
    if (wire) extraParts.push(wire);
  }
  return {
    output: textPieces.length > 0 ? textPieces.join('\n') : JSON.stringify(content),
    extraParts
  };
}

/**
 * Convert chat-style messages to Responses-native items.
 *
 * Roles keep their position in the list: the static system prefix belongs at
 * index 0 and alone (a second system item after history is folded into the head
 * by some providers, which moves it and busts the prefix cache), and the
 * turn-varying Runtime block is a user item.
 *
 * @param {Array} messages
 * @returns {Array} Responses-native items
 */
function chatMessagesToResponsesItems(messages) {
  const items = [];
  if (!Array.isArray(messages)) return items;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    switch (msg.role) {
    case 'system':
    case 'user': {
      const content = _contentToInputParts(msg.content);
      if (content.length > 0) items.push({ role: msg.role, content });
      break;
    }

    case 'assistant': {
      const stored = Array.isArray(msg._responsesOutput) ? msg._responsesOutput : [];
      if (stored.length > 0) {
        items.push(...stored);
        // Rare API shape: visible text only in output_text, not as a message item.
        if (!stored.some(i => i && i.type === 'message')) {
          const text = _assistantContentToText(msg.content);
          if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        }
        break;
      }
      const text = _assistantContentToText(msg.content);
      if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        if (!tc || tc.type !== 'function' || !tc.function) continue;
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {})
        });
      }
      break;
    }

    case 'tool': {
      if (!msg.tool_call_id) break;
      const { output, extraParts } = toolContentToOutput(msg.content);
      items.push({ type: 'function_call_output', call_id: msg.tool_call_id, output });
      // Files a tool wants the model to look at ride as a separate user item:
      // function_call_output takes a string, never content parts.
      if (extraParts.length > 0) items.push({ role: 'user', content: extraParts });
      break;
    }

    default:
      break;
    }
  }

  return items;
}

export { chatMessagesToResponsesItems, toolContentToOutput };
