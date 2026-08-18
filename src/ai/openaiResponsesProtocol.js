// src/ai/openaiResponsesProtocol.js
//
// Wire format for the ChatGPT Codex Responses backend: request building, SSE
// decoding, and the replay rules for a multi-round tool loop.
//
// This module is pure — no network, no credentials, no filesystem — so every
// shape below is covered by the sanitized fixtures in test/fixtures/openai.
//
// Three properties the probes pinned down and the code depends on:
//   1. `store` must be false and `previous_response_id` is rejected outright,
//      so the whole conversation is rebuilt from GemiX's own 30-message window
//      on every request. Turns that leave the window really are gone.
//   2. `response.completed.response.output` is not authoritative: complete
//      items (function calls in particular) arrive on `response.output_item.done`
//      and can be missing from the final array. The decoder keeps a canonical
//      map keyed by output_index/id where a `done` item always wins.
//   3. Only item shapes actually observed may be replayed on the next request;
//      anything else is dropped rather than echoed back at the backend.

/** Item types GemiX is allowed to send back in `input[]` on a later round. */
const REPLAYABLE_ITEM_TYPES = new Set([
  'reasoning',
  'message',
  'function_call',
  'function_call_output',
  'web_search_call',
  'image_generation_call'
]);

/** Content part types accepted inside a user/system input item. */
const INPUT_PART_TYPES = new Set(['input_text', 'input_image', 'input_file']);

// -- Request building --------------------------------------------------------

/**
 * Join a configured base URL with a path without letting the path escape the
 * base (a leading slash on the path would otherwise drop the base's own path
 * segment, sending Codex traffic to the domain root).
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const tail = String(path || '').replace(/^\/+/, '');
  return tail ? `${base}/${tail}` : base;
}

/** Strip internal bookkeeping from one content part, keeping only wire fields. */
function _wirePart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'input_text') {
    return typeof part.text === 'string' && part.text.length > 0
      ? { type: 'input_text', text: part.text }
      : null;
  }
  if (part.type === 'input_image') {
    return typeof part.image_url === 'string' && part.image_url
      ? { type: 'input_image', image_url: part.image_url }
      : null;
  }
  if (part.type === 'input_file') {
    if (typeof part.file_url === 'string' && part.file_url) {
      return { type: 'input_file', file_url: part.file_url };
    }
    // Inline files carry their own filename; the backend rejects one without it.
    if (typeof part.file_data === 'string' && part.file_data && typeof part.filename === 'string') {
      return { type: 'input_file', filename: part.filename, file_data: part.file_data };
    }
  }
  return null;
}

/** Keep only the wire fields of a replayable output item. */
function _wireItem(item) {
  if (!item || typeof item !== 'object' || !REPLAYABLE_ITEM_TYPES.has(item.type)) return null;

  switch (item.type) {
  case 'reasoning': {
    // Only worth replaying when it carries the encrypted chain; `status` is
    // output-only and rejected on input.
    if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) return null;
    const out = { type: 'reasoning', encrypted_content: item.encrypted_content };
    if (typeof item.id === 'string') out.id = item.id;
    if (Array.isArray(item.summary)) out.summary = item.summary;
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
  case 'web_search_call':
  case 'image_generation_call': {
    // Hosted calls are replayed by reference: the backend already holds the
    // result, and echoing a multi-megabyte base64 payload back would be both
    // wasteful and, for images, a second copy of user-visible content.
    const out = { type: item.type };
    if (typeof item.id === 'string') out.id = item.id;
    if (typeof item.status === 'string') out.status = item.status;
    return out;
  }
  default:
    return null;
  }
}

/**
 * Build the `input[]` array for a Codex Responses request from GemiX's
 * chat-style messages. The whole window is rebuilt every time: no
 * `previous_response_id`, no server-side state.
 *
 * @param {Array} messages - chat-style messages (system/user/assistant/tool)
 * @returns {Array} Responses input items
 */
function buildResponsesInput(messages) {
  const input = [];
  if (!Array.isArray(messages)) return input;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'system' || msg.role === 'user') {
      const parts = [];
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) parts.push({ type: 'input_text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          // Tool results and history use the chat-style `text` alias.
          const normalized = part && part.type === 'text'
            ? { type: 'input_text', text: part.text }
            : part;
          if (!normalized || !INPUT_PART_TYPES.has(normalized.type)) continue;
          const wire = _wirePart(normalized);
          if (wire) parts.push(wire);
        }
      }
      if (parts.length > 0) input.push({ role: msg.role, content: parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const stored = Array.isArray(msg._responsesOutput) ? msg._responsesOutput : [];
      let pushed = 0;
      for (const item of stored) {
        const wire = _wireItem(item);
        if (wire) {
          input.push(wire);
          pushed++;
        }
      }
      if (pushed === 0 && typeof msg.content === 'string' && msg.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] });
      }
      continue;
    }

    if (msg.role === 'tool') {
      if (!msg.tool_call_id) continue;
      const { output, extraParts } = toolContentToOutput(msg.content);
      input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output });
      // Files a tool wants the model to actually look at ride as a separate
      // user item: function_call_output takes a string, never content parts.
      if (extraParts.length > 0) input.push({ role: 'user', content: extraParts });
    }
  }

  return input;
}

/**
 * Split a tool result into the string the backend accepts as
 * `function_call_output` plus any input parts that must travel separately.
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

  const textPieces = [];
  const extraParts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' || part.type === 'input_text') {
      if (typeof part.text === 'string') textPieces.push(part.text);
      continue;
    }
    const wire = _wirePart(part);
    if (wire) extraParts.push(wire);
  }
  return { output: textPieces.join('\n'), extraParts };
}

/**
 * Build the request body. Strict allowlist: no xAI field (max_turns,
 * prompt_cache_key, include) and no public Responses option that was not
 * exercised against this backend ever reaches the wire.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.effort - reasoning effort
 * @param {Array} opts.input - from buildResponsesInput
 * @param {Array|null} [opts.tools] - hosted + function tools, already serialized
 * @param {string} [opts.toolChoice]
 * @param {object|null} [opts.responseFormat] - GemiX json_schema format
 * @returns {object}
 */
function buildResponsesBody({ model, effort, input, tools = null, toolChoice = 'auto', responseFormat = null }) {
  const body = {
    model,
    // Rejected as true by this backend: the conversation is client-side.
    store: false,
    stream: true,
    reasoning: { effort },
    input
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  if (responseFormat) {
    body.text = { format: responseFormat };
  }
  return body;
}

/**
 * Serialize GemiX tool definitions for this backend. Function tools use the
 * flat Responses shape; hosted tools (already written in wire form by the
 * registry) pass through untouched.
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

// -- SSE decoding ------------------------------------------------------------

/**
 * Incremental Server-Sent Events decoder.
 *
 * Handles what the transport actually sees: CRLF or LF line endings, UTF-8
 * sequences split across chunk boundaries, multiple `data:` lines per event,
 * comment lines, `[DONE]`, and a stream that ends without a terminator.
 */
class SseDecoder {
  constructor() {
    this._decoder = new TextDecoder('utf-8');
    this._buffer = '';
    this._dataLines = [];
  }

  /**
   * Feed one chunk and return the events completed by it.
   * @param {Uint8Array|Buffer} chunk
   * @returns {object[]} parsed JSON payloads, in order
   */
  push(chunk) {
    // `stream: true` keeps a partial multi-byte character in the decoder
    // instead of emitting a replacement character.
    this._buffer += this._decoder.decode(chunk, { stream: true });
    return this._drain(false);
  }

  /** Flush whatever a truncated stream left behind. */
  end() {
    this._buffer += this._decoder.decode();
    return this._drain(true);
  }

  _drain(isEnd) {
    const events = [];
    let newlineIdx;
    while ((newlineIdx = this._buffer.indexOf('\n')) !== -1) {
      const rawLine = this._buffer.slice(0, newlineIdx);
      this._buffer = this._buffer.slice(newlineIdx + 1);
      const event = this._consumeLine(rawLine);
      if (event !== undefined) events.push(event);
    }
    if (isEnd) {
      if (this._buffer) {
        const event = this._consumeLine(this._buffer);
        this._buffer = '';
        if (event !== undefined) events.push(event);
      }
      const trailing = this._flushEvent();
      if (trailing !== undefined) events.push(trailing);
    }
    return events;
  }

  _consumeLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return this._flushEvent();
    if (line.startsWith(':')) return undefined; // comment / keep-alive
    if (!line.startsWith('data:')) return undefined; // event:/id:/retry: carry no payload here
    this._dataLines.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  }

  _flushEvent() {
    if (this._dataLines.length === 0) return undefined;
    const payload = this._dataLines.join('\n');
    this._dataLines = [];
    if (payload === '[DONE]') return undefined;
    try {
      return JSON.parse(payload);
    } catch {
      // A single malformed event must not poison the rest of the stream.
      return undefined;
    }
  }
}

// -- Response assembly -------------------------------------------------------

/**
 * Accumulates SSE events into one normalized `output[]`.
 *
 * The canonical store is keyed by output_index (falling back to item id), and a
 * completed item always replaces whatever the deltas built, because the probe
 * showed `response.completed` can omit items that only ever appeared on
 * `response.output_item.done`.
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
    /** True once anything meaningful arrived — after this a retry would duplicate work. */
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
    // re-applying it would drop the results/annotations only the `done` event
    // carried.
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

    if (type === 'response.created' || type === 'response.in_progress') {
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

    if (type.endsWith('.delta') || type.endsWith('.done')) {
      // Text/argument deltas only matter as a signal that work has started; the
      // authoritative text arrives with the completed item.
      this.sawMeaningfulEvent = true;
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
          for (const [candidate, entry] of this._items) {
            if (id && entry.item?.id === id) { key = candidate; break; }
          }
          this._upsert(key || (id ? `id:${id}` : `ord:${this._order}`), item, true);
        }
      }
    }
  }

  /** The assembled response in the same shape a non-streaming call returns. */
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
 * A tool loop can emit several `message` items; the answer is the last one that
 * parses as a GemiX structured reply, else the last non-empty one.
 * @param {string[]} texts
 * @returns {string}
 */
function _pickAssistantText(texts) {
  for (let i = texts.length - 1; i >= 0; i--) {
    const candidate = texts[i]?.trim();
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
    if (texts[i]?.trim()) return texts[i];
  }
  return '';
}

/**
 * Convert an assembled response into the chat-style assistant message the
 * handler loop consumes, keeping the raw items for replay on the next round.
 * @param {object} response - from ResponseAssembler.toResponse()
 * @returns {object} { role, content, tool_calls?, _responsesOutput? }
 */
function responseToAssistantMessage(response) {
  const message = { role: 'assistant', content: '' };
  const toolCalls = [];
  const texts = [];
  const replayable = [];

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
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
          }
        });
      }
    }

    if (_wireItem(item)) replayable.push(item);
  }

  message.content = _pickAssistantText(texts).trim();
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (replayable.length > 0) message._responsesOutput = replayable;
  return message;
}

/**
 * Server-side search statistics for the research badge.
 * This backend has no X corpus, so xPosts is always 0 and the badge never shows
 * the X section.
 * @param {object} response
 * @returns {{ webSources: number, xPosts: number }}
 */
function extractSearchStats(response) {
  let webSources = 0;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== 'web_search_call') continue;
    const results = Array.isArray(item.results) ? item.results : [];
    const textResults = results.filter(r => r && r.type !== 'image_result');
    webSources += textResults.length || (results.length === 0 ? 1 : 0);
  }
  return { webSources, xPosts: 0 };
}

/**
 * Structured image hits from hosted web search, deduplicated by image URL.
 *
 * Only entries the tool itself produced are collected. A URL the model merely
 * wrote in its prose is not a search result and never becomes an attachment.
 * @param {object} response
 * @returns {Array<{imageUrl: string, thumbnailUrl: string|null, sourceUrl: string|null, caption: string|null}>}
 */
function collectImageResults(response) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== 'web_search_call' || !Array.isArray(item.results)) continue;
    for (const result of item.results) {
      if (!result || result.type !== 'image_result') continue;
      const imageUrl = typeof result.image_url === 'string' ? result.image_url.trim() : '';
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      out.push({
        imageUrl,
        thumbnailUrl: typeof result.thumbnail_url === 'string' ? result.thumbnail_url : null,
        sourceUrl: typeof result.source_website_url === 'string' ? result.source_website_url : null,
        caption: typeof result.caption === 'string' ? result.caption : null
      });
    }
  }
  return out;
}

/**
 * `url_citation` annotations from the message items, in document order and
 * deduplicated by URL. Out-of-range or malformed offsets are dropped rather
 * than trusted, so a bad annotation can never corrupt the reply text.
 * @param {object} response
 * @returns {Array<{url: string, title: string|null, start: number|null, end: number|null}>}
 */
function collectCitations(response) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || !Array.isArray(part.annotations)) continue;
      const textLength = typeof part.text === 'string' ? part.text.length : 0;
      for (const annotation of part.annotations) {
        if (!annotation || annotation.type !== 'url_citation') continue;
        const url = typeof annotation.url === 'string' ? annotation.url.trim() : '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const start = Number.isInteger(annotation.start_index) ? annotation.start_index : null;
        const end = Number.isInteger(annotation.end_index) ? annotation.end_index : null;
        const inRange = start !== null && end !== null && start >= 0 && end >= start && end <= textLength;
        out.push({
          url,
          title: typeof annotation.title === 'string' ? annotation.title : null,
          start: inRange ? start : null,
          end: inRange ? end : null
        });
      }
    }
  }
  return out;
}

export {
  REPLAYABLE_ITEM_TYPES,
  joinUrl,
  buildResponsesInput,
  buildResponsesBody,
  toolContentToOutput,
  toolsToWire,
  SseDecoder,
  ResponseAssembler,
  responseToAssistantMessage,
  extractSearchStats,
  collectImageResults,
  collectCitations
};
