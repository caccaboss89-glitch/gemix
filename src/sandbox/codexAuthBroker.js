// src/sandbox/codexAuthBroker.js
//
// The trust boundary that lets Codex Build authenticate without ever holding a
// credential.
//
// `codex exec` can run shell commands inside the sandbox, so anything the CLI
// can read — env, argv, files, /proc — the model can read too. Putting the real
// OAuth bearer there would not be isolation, it would be publication. Instead
// the CLI is pointed at this broker and given an opaque ticket:
//
//   sandbox ──ticket──> egress proxy ──> broker (host) ──real bearer──> Codex API
//
// The sandbox network has no route to the host, so the proxy is what carries
// that middle hop: it is the one place allowed to dial the broker directly
// instead of sending the request out through the residential exit.
//
// The ticket is minted per build invocation, expires with it, is revoked in the
// caller's `finally`, and means nothing anywhere else. The real
// `Authorization` and `ChatGPT-Account-ID` headers are attached here, on the
// host, outside everything the model can reach.
//
// Nothing in this file logs a ticket, a bearer or an account id, and the
// forwarded request body is never inspected or stored.

import http from 'http';
import crypto from 'crypto';
import envConfig from '../config/env.js';
import { getOpenAiAuth } from '../config/openaiAuth.js';
import { joinUrl } from '../ai/openaiResponsesProtocol.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CodexBroker');

/** Live tickets: ticket -> { expiresAt, workspaceId, uses }. */
const _tickets = new Map();

/** Headers a sandbox request may not dictate; the broker sets them itself. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'chatgpt-account-id',
  'host',
  'connection',
  'proxy-authorization',
  'content-length'
]);

let _server = null;

/** Drop tickets whose invocation is over. */
function _sweep(now = Date.now()) {
  for (const [ticket, entry] of _tickets) {
    if (entry.expiresAt <= now) _tickets.delete(ticket);
  }
}

/**
 * Mint a ticket for one build invocation.
 *
 * @param {object} opts
 * @param {string} opts.workspaceId - for logging only; never sent upstream
 * @param {number} opts.ttlMs - the invocation's own ceiling
 * @returns {string} the opaque ticket handed to the sandbox
 */
function mintTicket({ workspaceId, ttlMs }) {
  const ttl = Number(ttlMs);
  if (!(ttl > 0)) throw new Error('mintTicket: ttlMs must be a positive number');
  _sweep();
  const ticket = crypto.randomBytes(32).toString('base64url');
  _tickets.set(ticket, { workspaceId, expiresAt: Date.now() + ttl, uses: 0 });
  return ticket;
}

/** Invalidate a ticket the moment its invocation ends. */
function revokeTicket(ticket) {
  if (ticket) _tickets.delete(ticket);
}

/** How many tickets are currently valid — diagnostics only. */
function activeTicketCount() {
  _sweep();
  return _tickets.size;
}

/**
 * Validate the ticket a sandbox request carries.
 * @param {string|undefined} authorizationHeader
 * @returns {{ ok: true, entry: object } | { ok: false, reason: string }}
 */
function validateTicket(authorizationHeader) {
  const raw = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, reason: 'missing ticket' };

  const entry = _tickets.get(match[1]);
  if (!entry) return { ok: false, reason: 'unknown ticket' };
  if (entry.expiresAt <= Date.now()) {
    _tickets.delete(match[1]);
    return { ok: false, reason: 'expired ticket' };
  }
  entry.uses++;
  return { ok: true, entry };
}

/**
 * Headers for the upstream call: everything the sandbox sent except what it is
 * not allowed to choose, plus the real credentials.
 * @param {object} incomingHeaders
 * @param {{accessToken: string, chatgptAccountId: string}} auth
 * @returns {object}
 */
function buildUpstreamHeaders(incomingHeaders, auth) {
  const out = {};
  for (const [name, value] of Object.entries(incomingHeaders || {})) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  out['Authorization'] = `Bearer ${auth.accessToken}`;
  out['ChatGPT-Account-ID'] = auth.chatgptAccountId;
  return out;
}

/** Read a request body with a hard ceiling so one build cannot exhaust the host. */
function _readBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function _deny(res, status, reason) {
  log.warn(`refused a sandbox request: ${reason}`);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Codex broker refused the request: ${reason}` } }));
}

async function _handle(req, res) {
  const check = validateTicket(req.headers.authorization);
  if (!check.ok) return _deny(res, 401, check.reason);

  let body;
  try {
    body = await _readBody(req);
  } catch (err) {
    return _deny(res, 413, err.message);
  }

  let auth;
  try {
    auth = getOpenAiAuth();
  } catch (err) {
    // The reason is safe to log; the credential itself never is.
    return _deny(res, 503, `no usable credential (${err.code || err.message})`);
  }

  const url = joinUrl(envConfig.OPENAI_BASE_URL, req.url.replace(/^\/+/, ''));
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, auth),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual'
    });

    const headers = {};
    upstream.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'content-encoding') headers[name] = value;
    });
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
    log.info(`forwarded ${req.method} ${req.url.split('?')[0]} -> ${upstream.status}`);
  } catch (err) {
    _deny(res, 502, `upstream unreachable (${err.message})`);
  }
}

/**
 * Start the broker.
 *
 * Bound to CODEX_BROKER_BIND, loopback by default: the sandbox reaches it
 * through the egress proxy, which the operator points at a socat relay on the
 * egress gateway — the same shape as the notify server. A live ticket is still
 * required for any answer, but the listener is not on every interface as well.
 *
 * @returns {Promise<void>}
 */
function startBroker() {
  if (_server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    _server = http.createServer((req, res) => {
      _handle(req, res).catch((err) => {
        try { _deny(res, 500, err.message); } catch { /* response already sent */ }
      });
    });
    _server.on('error', (err) => {
      _server = null;
      reject(err);
    });
    _server.listen(envConfig.CODEX_BROKER_PORT, envConfig.CODEX_BROKER_BIND, () => {
      log.info(`listening on ${envConfig.CODEX_BROKER_BIND}:${envConfig.CODEX_BROKER_PORT} for Codex Build`);
      resolve();
    });
  });
}

/** Stop the broker and drop every outstanding ticket. */
function stopBroker() {
  _tickets.clear();
  if (!_server) return Promise.resolve();
  const server = _server;
  _server = null;
  return new Promise((resolve) => server.close(resolve));
}

export {
  STRIPPED_REQUEST_HEADERS,
  mintTicket,
  revokeTicket,
  validateTicket,
  buildUpstreamHeaders,
  activeTicketCount,
  startBroker,
  stopBroker
};
