// src/ai/transport/sse.js
//
// Incremental Server-Sent Events decoder for the Responses stream.
//
// Handles what the transport actually sees on the wire: CRLF or LF line
// endings, UTF-8 sequences split across chunk boundaries, several `data:` lines
// per event, comment/keep-alive lines, `[DONE]`, and a stream that ends without
// a blank-line terminator.

class SseDecoder {
  constructor() {
    this._decoder = new TextDecoder('utf-8');
    this._buffer = '';
    this._dataLines = [];
  }

  /**
   * Feed one chunk and return the events it completed.
   * @param {Uint8Array|Buffer|string} chunk
   * @returns {object[]} parsed JSON payloads, in order
   */
  push(chunk) {
    // `stream: true` keeps a partial multi-byte character inside the decoder
    // instead of emitting a replacement character at the chunk boundary.
    this._buffer += typeof chunk === 'string'
      ? chunk
      : this._decoder.decode(chunk, { stream: true });
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

export { SseDecoder };
