// src/ai/responsesItems.js
//
// Constructors for GemiX's internal conversation, which is Responses-native end
// to end: the same typed items the wire uses, built once by whoever
// produces the content and never translated again.
//
// There is deliberately no second, chat-style representation. History entries,
// the current turn, tool results and the model's own output are all items from
// the moment they exist, so ai/transport/responsesProtocol.js only has to
// sanitize them — it never has to guess what an entry meant.
//
// The shapes in play:
//   {role:'system'|'user', content: [input_text|input_image|input_file]}
//   {type:'message', role:'assistant', content:[{type:'output_text', text}]}
//   {type:'function_call', call_id, name, arguments}
//   {type:'function_call_output', call_id, output}
//   {type:'reasoning', encrypted_content}   (replayed, never built here)

/** Content parts for a role item, from a string or an existing part list. */
function inputParts(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part && typeof part === 'object' && typeof part.type === 'string');
}

/** A user item, or null when there is nothing to say. */
function userItem(content) {
  const parts = inputParts(content);
  return parts.length > 0 ? { role: 'user', content: parts } : null;
}

/** The static system prefix. Always index 0, always alone (prefix cache). */
function systemItem(text) {
  return { role: 'system', content: [{ type: 'input_text', text }] };
}

/** An assistant turn from history: its visible words, nothing else. */
function assistantTextItem(text) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

/**
 * A tool result as items.
 *
 * `function_call_output.output` is a string, so a tool that hands the model
 * files produces two items: the envelope as the output, and the labelled parts
 * as a user item behind it. Splitting them here is what keeps each label next
 * to the file it names — folding everything into the output string would leave
 * the files anonymous.
 *
 * The companion item is marked so the round loop can drop it once the model has
 * looked at it: a preview is worth its tokens on the round it arrives, and not
 * after.
 *
 * @param {string} callId
 * @param {string|Array|object} content - whatever the tool returned
 * @returns {object[]}
 */
function toolResultItems(callId, content) {
  if (typeof content === 'string') {
    return [{ type: 'function_call_output', call_id: callId, output: content }];
  }
  if (!Array.isArray(content)) {
    let output;
    try { output = JSON.stringify(content); }
    catch { output = String(content ?? ''); }
    return [{ type: 'function_call_output', call_id: callId, output }];
  }

  const textPieces = [];
  const extraParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'input_text' && typeof part.text === 'string') {
      // Only the leading envelope belongs in the output string; a later text
      // part is a label for the file after it and has to stay beside it.
      if (textPieces.length === 0 && extraParts.length === 0) textPieces.push(part.text);
      else extraParts.push(part);
      continue;
    }
    extraParts.push(part);
  }

  const items = [{
    type: 'function_call_output',
    call_id: callId,
    output: textPieces.length > 0 ? textPieces.join('\n') : JSON.stringify(content)
  }];
  if (extraParts.length > 0) {
    items.push({ role: 'user', content: extraParts, _toolMedia: callId });
  }
  return items;
}

/** Part types worth dropping once the model has had its round to look. */
const HEAVY_PART_TYPES = new Set(['input_image', 'input_file']);

/**
 * Drop tool-media items the model has already seen a round with.
 *
 * Mutates `items` in place and returns how many were dropped. The envelope in
 * `function_call_output` stays either way, so the model keeps the facts and
 * loses only the pixels.
 *
 * @param {object[]} items
 * @returns {number}
 */
function pruneSeenToolMedia(items) {
  let dropped = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item?._toolMedia) continue;
    if (item._seenRound) {
      items.splice(i, 1);
      dropped += 1;
    } else if (item.content.some((p) => HEAVY_PART_TYPES.has(p.type))) {
      item._seenRound = true;
    }
  }
  return dropped;
}

export {
  assistantTextItem,
  inputParts,
  pruneSeenToolMedia,
  systemItem,
  toolResultItems,
  userItem
};
