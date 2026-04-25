// src/sandbox/pythonKernel.js
// Thin Jupyter Server client used by the GemiX sandbox.
//
// Protocol summary (Jupyter messaging spec v5.4):
//   1. POST /api/kernels        → spawn an ipykernel inside the container.
//   2. WS   /api/kernels/{id}/channels?token=...
//        ← bi-directional channel that multiplexes the shell, iopub, stdin
//          and control ZMQ sockets as a single WebSocket frame stream.
//   3. To run code: send `execute_request` on the shell channel with a fresh
//      msg_id, then collect everything whose `parent_header.msg_id` matches
//      until the iopub publishes `status: idle`.
//
// Output handling here is intentionally narrow: stdout / stderr text streams,
// `execute_result` text, `display_data` (text + images), and `error` (with
// traceback). Anything else is ignored.
//
// This file is pure transport — no project / file-tracking logic. The caller
// (sandboxManager → codeExecution tool) decides what to do with the result.

const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const { CODE_EXEC_MAX_OUTPUT_BYTES } = require('../config/constants');
const { createLogger } = require('../utils/logger');

const log = createLogger('PythonKernel');

const KERNEL_BOOT_TIMEOUT_MS = 30_000;
const WS_OPEN_TIMEOUT_MS = 15_000;

/** Generate a random message id ("msg_id") in Jupyter style. */
function _msgId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Build a Jupyter v5.4 message envelope. */
function _buildMessage(msgType, content, sessionId) {
  const msgId = _msgId();
  return {
    header: {
      msg_id: msgId,
      username: 'gemix',
      session: sessionId,
      msg_type: msgType,
      version: '5.4',
      date: new Date().toISOString(),
    },
    parent_header: {},
    metadata: {},
    content,
    buffers: [],
    channel: msgType === 'execute_request' ? 'shell' : 'shell',
  };
}

/**
 * Wrap a Jupyter Server REST call. We use raw http to avoid pulling in fetch
 * polyfills on older Node and to keep the dependency surface small.
 */
function _httpJson({ host, port, method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host,
      port,
      method,
      path,
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(text ? JSON.parse(text) : {}); }
          catch (e) { reject(new Error(`Invalid JSON from kernel API: ${e.message}`)); }
        } else {
          reject(new Error(`Kernel API ${method} ${path} → ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * A single connection to one Jupyter kernel. Reusable across executions.
 *
 * Lifecycle:
 *   const k = new PythonKernel({ host, port, token });
 *   await k.start();           // POST /api/kernels + open WS
 *   const r = await k.execute("print('hi')", { timeoutMs: 30000 });
 *   await k.shutdown();
 */
class PythonKernel {
  constructor({ host, port, token }) {
    if (!host || !port || !token) throw new Error('host, port, token are required');
    this.host = host;
    this.port = port;
    this.token = token;

    this.kernelId = null;
    this.sessionId = _msgId();
    this.ws = null;
    this._ready = false;
    this._pending = new Map(); // msg_id → { resolve, reject, partial }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    if (this._ready) return;
    const startedAt = Date.now();
    let lastErr;
    while (Date.now() - startedAt < KERNEL_BOOT_TIMEOUT_MS) {
      try {
        const k = await _httpJson({
          host: this.host, port: this.port, token: this.token,
          method: 'POST', path: '/api/kernels',
          body: { name: 'python3' },
        });
        this.kernelId = k.id;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!this.kernelId) throw new Error(`Kernel boot failed: ${lastErr?.message || 'timeout'}`);

    await this._openWebSocket();
    this._ready = true;
    log.info(`kernel ready (id=${this.kernelId.slice(0, 8)}…)`);
  }

  async shutdown() {
    this._ready = false;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.terminate();
      }
    } catch { /* ignore */ }
    this.ws = null;

    if (this.kernelId) {
      try {
        await _httpJson({
          host: this.host, port: this.port, token: this.token,
          method: 'DELETE', path: `/api/kernels/${this.kernelId}`,
        });
      } catch (e) {
        log.warn(`kernel shutdown HTTP error (ignored): ${e.message}`);
      }
      this.kernelId = null;
    }

    // Reject any pending executes
    for (const [, p] of this._pending) {
      try { p.reject(new Error('Kernel shut down before reply')); } catch { /* */ }
    }
    this._pending.clear();
  }

  isAlive() {
    return this._ready && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // ── Execution ──────────────────────────────────────────────────────────

  /**
   * Run a Python snippet on the kernel.
   * Resolves with:
   *   { status, stdout, stderr, error?, traceback?, results, display, truncated }
   *
   * - `status` is "ok" | "error" | "aborted" | "timeout".
   * - `results` and `display` carry text from execute_result / display_data
   *   payloads (strings only — no inline base64 images surfaced to the AI).
   * - `truncated` is true if cumulative stdout+stderr was clipped.
   *
   * @param {string} code
   * @param {{ timeoutMs?: number }} options
   */
  execute(code, { timeoutMs = 30_000 } = {}) {
    if (!this.isAlive()) return Promise.reject(new Error('Kernel not ready'));

    const msg = _buildMessage('execute_request', {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    }, this.sessionId);

    const msgId = msg.header.msg_id;
    const partial = {
      stdout: '',
      stderr: '',
      results: [],
      display: [],
      error: null,
      traceback: null,
      truncated: false,
      status: 'unknown',
      _bytes: 0,
      _idleSeen: false,
      _replySeen: false,
    };

    return new Promise((resolve, reject) => {
      const settle = (final) => {
        const handle = this._pending.get(msgId);
        if (!handle) return;
        clearTimeout(handle.timer);
        this._pending.delete(msgId);
        resolve(final);
      };

      const fail = (err) => {
        const handle = this._pending.get(msgId);
        if (!handle) return;
        clearTimeout(handle.timer);
        this._pending.delete(msgId);
        reject(err);
      };

      const timer = setTimeout(async () => {
        log.warn(`execute timeout (${timeoutMs}ms) — interrupting kernel`);
        try {
          await _httpJson({
            host: this.host, port: this.port, token: this.token,
            method: 'POST', path: `/api/kernels/${this.kernelId}/interrupt`,
          });
        } catch { /* */ }
        partial.status = 'timeout';
        partial.error = 'TimeoutError';
        partial.traceback = `Execution exceeded ${timeoutMs} ms and was interrupted.`;
        settle(partial);
      }, timeoutMs);

      this._pending.set(msgId, {
        partial,
        settle,
        reject: fail,
        timer,
      });

      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        fail(new Error(`WS send failed: ${e.message}`));
      }
    });
  }

  // ── WebSocket plumbing ─────────────────────────────────────────────────

  _openWebSocket() {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.port}/api/kernels/${this.kernelId}/channels?token=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(url, {
        // Token is also accepted as auth header for some configs
        headers: { Authorization: `token ${this.token}` },
        perMessageDeflate: false,
      });

      const openTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* */ }
        reject(new Error('Kernel WS open timeout'));
      }, WS_OPEN_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(openTimer);
        this.ws = ws;
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(openTimer);
        if (!this.ws) reject(err);
        else log.warn(`WS error: ${err.message}`);
      });

      ws.on('close', () => {
        this._ready = false;
        for (const [, p] of this._pending) {
          try { p.reject(new Error('Kernel WS closed')); } catch { /* */ }
        }
        this._pending.clear();
      });

      ws.on('message', (raw) => this._onMessage(raw));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    const parentId = msg.parent_header && msg.parent_header.msg_id;
    if (!parentId) return;
    const handle = this._pending.get(parentId);
    if (!handle) return;
    const p = handle.partial;

    const type = msg.header && msg.header.msg_type;
    const channel = msg.channel || '';
    const content = msg.content || {};
    const cap = CODE_EXEC_MAX_OUTPUT_BYTES;

    const appendStream = (target, text) => {
      if (typeof text !== 'string' || text.length === 0) return;
      const remaining = cap - p._bytes;
      if (remaining <= 0) {
        p.truncated = true;
        return;
      }
      if (text.length > remaining) {
        p[target] += text.slice(0, remaining);
        p._bytes = cap;
        p.truncated = true;
      } else {
        p[target] += text;
        p._bytes += text.length;
      }
    };

    switch (type) {
      case 'stream': {
        const t = content.name === 'stderr' ? 'stderr' : 'stdout';
        appendStream(t, content.text);
        break;
      }
      case 'execute_result': {
        const txt = content.data && content.data['text/plain'];
        if (typeof txt === 'string') p.results.push(txt);
        break;
      }
      case 'display_data': {
        const txt = content.data && content.data['text/plain'];
        if (typeof txt === 'string') p.display.push(txt);
        break;
      }
      case 'error': {
        p.error = `${content.ename}: ${content.evalue}`;
        if (Array.isArray(content.traceback)) {
          p.traceback = content.traceback.join('\n');
        }
        break;
      }
      case 'status': {
        if (content.execution_state === 'idle' && channel === 'iopub') {
          p._idleSeen = true;
        }
        break;
      }
      case 'execute_reply': {
        p._replySeen = true;
        if (content.status === 'ok') {
          if (p.status === 'unknown') p.status = 'ok';
        } else if (content.status === 'error') {
          p.status = 'error';
          if (!p.error) {
            p.error = `${content.ename || 'Error'}: ${content.evalue || ''}`;
            if (Array.isArray(content.traceback)) p.traceback = content.traceback.join('\n');
          }
        } else {
          p.status = content.status || 'unknown';
        }
        break;
      }
      default: /* ignore */ break;
    }

    if (p._idleSeen && p._replySeen) {
      handle.settle(p);
    }
  }
}

module.exports = { PythonKernel };
