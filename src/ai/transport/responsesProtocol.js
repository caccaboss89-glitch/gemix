// src/ai/transport/responsesProtocol.js
//
// The OpenAI Responses wire format, and nothing else: no network, no
// credentials, no filesystem, no provider names. Everything here is pure, so
// the request and response shapes can be exercised directly in memory.
//
// GemiX's internal conversation is Responses-native — the same typed items the
// wire uses (`{role, content:[parts]}`, `function_call`, `function_call_output`,
// `message`, `reasoning`) — so this module sanitizes rather than translates.
// Internal bookkeeping fields (anything starting with `_`) are dropped at this
// boundary; they never reach a provider.
//
// Three properties every profile depends on:
//   1. `store:false` and no `previous_response_id`: the whole conversation is
//      rebuilt from GemiX's own window on every request.
//   2. `response.completed.response.output` is not authoritative — complete
//      items (function calls in particular) arrive on `response.output_item.done`
//      and can be missing from the final array. A `done` item always wins.
//   3. Only item shapes on the profile's replay allowlist go back out; anything
//      else is dropped rather than echoed at a backend that never sent it.

/** Content part types accepted inside a user/system input item. */
const INPUT_PART_TYPES = new Set(['input_text', 'input_image', 'input_file']);

/** Item types every Responses provider accepts back in `input[]`. */
const BASE_REPLAYABLE_ITEM_TYPES = Object.freeze([
  'reasoning',
  'message',
  'function_call',
  'function_call_output'
]);

// -- Input sanitization ------------------------------------------------------

/** Keep only the wire fields of one content part; null when unusable. */
function wirePart(part) {
  if (!part || typeof part !== 'object') return null;
  // Chat-style `text` / `image_url` parts still reach this boundary from tool
  // results and from history entries the phase-8 migration has not reached yet.
  let type = part.type;
  if (type === 'text') type = 'input_text';
  else if (type === 'image_url') type = 'input_image';

  if (type === 'input_text') {
    return typeof part.text === 'string' && part.text.length > 0
      ? { type: 'input_text', text: part.text }
      : null;
  }
  if (type === 'input_image') {
    const url = typeof part.image_url === 'string'
      ? part.image_url
      : (typeof part.image_url?.url === 'string' ? part.image_url.url : null);
    if (!url) return null;
    const out = { type: 'input_image', image_url: url };
    if (typeof part.detail === 'string' && part.detail) out.detail = part.detail;
    return out;
  }
  if (type === 'input_file') {
    if (typeof part.file_url === 'string' && part.file_url) {
      return { type: 'input_file', file_url: part.file_url };
    }
    // Inline files carry their own filename; a backend rejects one without it.
    if (typeof part.file_data === 'string' && part.file_data && typeof part.filename === 'string') {
      return { type: 'input_file', filename: part.filename, file_data: part.file_data };
    }
  }
  return null;
}

/** Sanitize one role item (`system` / `user` / `assistant` with input parts). */
function _wireRoleItem(item) {
  const role = item.role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'developer') return null;

  if (typeof item.content === 'string') {
    return item.content.length > 0 ? { role, content: item.content } : null;
  }
  if (!Array.isArray(item.content)) return null;

  const parts = [];
  for (const part of item.content) {
    const wire = wirePart(part);
    if (wire) parts.push(wire);
  }
  return parts.length > 0 ? { role, content: parts } : null;
}

/**
 * Keep only the wire fields of one typed output item, when the profile allows
 * replaying its type.
 *
 * @param {object} item
 * @param {Set<string>} replayable - the profile's allowlist
 * @returns {object|null}
 */
function wireItem(item, replayable) {
  if (!item || typeof item !== 'object' || typeof item.type !== 'string') return null;
  if (!replayable.has(item.type)) return null;

  switch (item.type) {
  case 'reasoning': {
    // Worth replaying only when it carries the encrypted chain; `status` is
    // output-only and rejected on input.
    if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) return null;
    const out = { type: 'reasoning', encrypted_content: item.encrypted_content };
    if (typeof item.id === 'string') out.id = item.id;
    if (Array.isArray(item.summary)) out.summary = item.summary;
    if (Array.isArray(item.content)) out.content = item.content;
    return out;
  }
  case 'message': {
    if (!Array.isArray(item.content)) return null;
    const content = item.content
      .filter(p => p && p.type === 'output_text' && typeof p.text === 'string')
      .map(p => ({ type: 'output_text', text: p.text }));
    if (content.length === 0) return null;
    return { type: 'message', role: item.role || 'assistant', content };
  }
  case 'function_call': {
    const callId = item.call_id || item.id;
    if (!callId || typeof item.name !== 'string') return null;
    return {
      type: 'function_call',
      call_id: callId,
      name: item.name,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
    };
  }
  case 'function_call_output': {
    if (!item.call_id) return null;
    return {
      type: 'function_call_output',
      call_id: item.call_id,
      output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
    };
  }
  default: {
    // Provider server-side items (web_search_call, custom_tool_call, …) are
    // replayed by reference: the backend still holds the result, and echoing a
    // multi-megabyte payload back would be pure waste.
    const out = { type: item.type };
    if (typeof item.id === 'string') out.id = item.id;
    if (typeof item.status === 'string') out.status = item.status;
    return out;
  }
  }
}

/**
 * Sanitize a Responses-native conversation into the `input[]` a provider accepts.
 *
 * @param {Array} items - GemiX's internal item list (already Responses-shaped)
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.replayableItemTypes] - profile allowlist
 * @returns {Array}
 */
function buildResponsesInput(items, opts = {}) {
  const replayable = new Set(opts.replayableItemTypes || BASE_REPLAYABLE_ITEM_TYPES);
  const input = [];
  if (!Array.isArray(items)) return input;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.type === 'string') {
      const wire = wireItem(item, replayable);
      if (wire) input.push(wire);
      continue;
    }
    const roleItem = _wireRoleItem(item);
    if (roleItem) input.push(roleItem);
  }
  return input;
}

/**
 * Serialize GemiX tool definitions for the wire. Function tools use the flat
 * Responses shape; a provider-native tool object (already `{type: '…'}`) is
 * passed through by its extension, never invented here.
 *
 * @param {Array|null} tools
 * @returns {Array|null}
 */
function toolsToWire(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.function) {
      out.push({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || { type: 'object', properties: {} }
      });
      continue;
    }
    if (typeof tool.type === 'string' && tool.type !== 'function') out.push({ ...tool });
  }
  return out.length > 0 ? out : null;
}

/**
 * Build the request body. SSE-only and stateless by construction: `stream` is
 * always true, `store` always false, and no `previous_response_id` is ever set.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array} opts.input - from buildResponsesInput
 * @param {string} [opts.reasoningEffort]
 * @param {Array|null} [opts.tools] - already wire-shaped
 * @param {string} [opts.toolChoice]
 * @param {object|null} [opts.responseFormat] - json_schema format object
 * @param {number} [opts.maxOutputTokens]
 * @param {string[]} [opts.include] - standard Responses includes (e.g. the
 *   encrypted reasoning chain needed for stateless replay)
 * @param {string|null} [opts.promptCacheKey] - standard Responses cache hint
 * @returns {object}
 */
function buildResponsesBody(opts) {
  const {
    model,
    input,
    reasoningEffort = null,
    tools = null,
    toolChoice = 'auto',
    responseFormat = null,
    maxOutputTokens = null,
    include = null,
    promptCacheKey = null
  } = opts;

  const body = {
    model,
    stream: true,
    store: false,
    input
  };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  if (typeof promptCacheKey === 'string' && promptCacheKey) body.prompt_cache_key = promptCacheKey;
  if (Number.isFinite(maxOutputTokens)) body.max_output_tokens = maxOutputTokens;
  if (Array.isArray(include) && include.length > 0) body.include = [...include];
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  if (responseFormat) body.text = { format: responseFormat };
  return body;
}

// -- Response assembly -------------------------------------------------------

/**
 * Accumulates SSE events into one normalized `output[]`.
 *
 * The canonical store is keyed by output_index (falling back to item id), and a
 * completed item always replaces whatever the deltas built: `response.completed`
 * can omit items that only ever appeared on `response.output_item.done`.
 */
class ResponseAssembler {
  constructor() {
    /** @type {Map<string, {order: number, item: object, done: boolean}>} */
    this._items = new Map();
    this._order = 0;
    this.status = null;
    this.responseId = null;
    this.usage = null;
    this.error = null;
    this.incompleteReason = null;
    /** True once anything meaningful arrived — after this a replay would duplicate work. */
    this.sawMeaningfulEvent = false;
  }

  _key(event, item) {
    if (Number.isInteger(event?.output_index)) return `idx:${event.output_index}`;
    const id = item?.id || event?.item_id;
    return id ? `id:${id}` : `ord:${this._order}`;
  }

  _upsert(key, item, done) {
    const existing = this._items.get(key);
    if (!existing) {
      this._items.set(key, { order: this._order++, item, done });
      return;
    }
    // A completed item is final. Neither a late delta nor the array carried by
    // `response.completed` may replace it: that array is the lossy one, and
    // re-applying it would drop what only the `done` event carried.
    if (existing.done) return;
    existing.item = item;
    existing.done = done;
  }

  /**
   * Apply one decoded SSE event.
   * @param {object} event
   */
  apply(event) {
    const type = event?.type;
    if (typeof type !== 'string') return;

    if (type === 'error') {
      this.error = event.error || event;
      return;
    }

    if (type === 'response.created' || type === 'response.in_progress' || type === 'response.queued') {
      if (event.response?.id) this.responseId = event.response.id;
      return;
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = event.item;
      if (!item || typeof item !== 'object') return;
      this.sawMeaningfulEvent = true;
      this._upsert(this._key(event, item), item, type === 'response.output_item.done');
      return;
    }

    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const response = event.response || {};
      this.status = response.status || type.slice('response.'.length);
      if (response.id) this.responseId = response.id;
      if (response.usage) this.usage = response.usage;
      if (response.error) this.error = response.error;
      if (response.incomplete_details?.reason) this.incompleteReason = response.incomplete_details.reason;
      if (Array.isArray(response.output)) {
        for (const item of response.output) {
          if (!item || typeof item !== 'object') continue;
          this.sawMeaningfulEvent = true;
          const id = item.id;
          // Match by id so a final item lands on the entry the stream already
          // built for it instead of duplicating it.
          let key = null;
          if (id) {
            for (const [candidate, entry] of this._items) {
              if (entry.item?.id === id) { key = candidate; break; }
            }
          }
          this._upsert(key || (id ? `id:${id}` : `ord:${this._order}`), item, true);
        }
      }
      return;
    }

    if (type.endsWith('.delta') || type.endsWith('.done')) {
      // Text/argument deltas only matter as a signal that work has started; the
      // authoritative text arrives with the completed item.
      this.sawMeaningfulEvent = true;
    }
  }

  /** The assembled response, in the shape a non-streaming call would return. */
  toResponse() {
    const output = [...this._items.values()]
      .sort((a, b) => a.order - b.order)
      .map(entry => entry.item);
    return {
      id: this.responseId,
      status: this.status,
      output,
      usage: this.usage,
      error: this.error,
      incomplete_reason: this.incompleteReason
    };
  }
}

// -- Reading an assembled response -------------------------------------------

/**
 * Pick the user-facing text out of the message items.
 *
 * With server-side tools the agentic loop narrates itself: a provider emits one
 * `message` item per step and only the last is the answer. Joining them would
 * break the structured JSON, so prefer the last piece that parses as a reply,
 * else the last non-empty one.
 *
 * @param {string[]} texts
 * @returns {string}
 */
function pickAssistantText(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return '';
  if (texts.length === 1) return texts[0];
  for (let i = texts.length - 1; i >= 0; i--) {
    const candidate = typeof texts[i] === 'string' ? texts[i].trim() : '';
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (typeof parsed.response === 'string' || typeof parsed.message === 'string')) {
        return texts[i];
      }
    } catch { /* try an earlier message */ }
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    if (typeof texts[i] === 'string' && texts[i].trim()) return texts[i];
  }
  return texts[texts.length - 1] || '';
}

/**
 * Read an assembled response into the turn result the agent loop consumes:
 * the visible text, the tool calls to run, and the raw items to replay next round.
 *
 * @param {object} response - from ResponseAssembler.toResponse()
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.replayableItemTypes] - profile allowlist
 * @returns {{ text: string, toolCalls: Array, replayItems: Array, status: string|null,
 *   incompleteReason: string|null, usage: object|null }}
 */
function readResponse(response, opts = {}) {
  const replayable = new Set(opts.replayableItemTypes || BASE_REPLAYABLE_ITEM_TYPES);
  const toolCalls = [];
  const texts = [];
  const replayItems = [];

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' && Array.isArray(item.content)) {
      const text = item.content
        .filter(p => p && p.type === 'output_text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('');
      if (text.trim()) texts.push(text);
    } else if (item.type === 'function_call') {
      const callId = item.call_id || item.id;
      if (callId && typeof item.name === 'string') {
        toolCalls.push({
          id: callId,
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        });
      }
    }

    if (wireItem(item, replayable)) replayItems.push(item);
  }

  return {
    text: pickAssistantText(texts).trim(),
    toolCalls,
    replayItems,
    status: response?.status ?? null,
    incompleteReason: response?.incomplete_reason ?? null,
    usage: response?.usage ?? null
  };
}

// -- Item constructors used by the agent loop --------------------------------

/** A `function_call_output` item for one executed tool call. */
function functionCallOutputItem(callId, output) {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: typeof output === 'string' ? output : JSON.stringify(output ?? '')
  };
}

/** A role item carrying plain text (system prompt, runtime block, reminders). */
function textItem(role, text) {
  return { role, content: [{ type: 'input_text', text: String(text ?? '') }] };
}

export {
  INPUT_PART_TYPES,
  BASE_REPLAYABLE_ITEM_TYPES,
  wirePart,
  wireItem,
  buildResponsesInput,
  buildResponsesBody,
  toolsToWire,
  ResponseAssembler,
  pickAssistantText,
  readResponse,
  functionCallOutputItem,
  textItem
};
