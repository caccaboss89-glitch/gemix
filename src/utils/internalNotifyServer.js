// src/utils/internalNotifyServer.js
// Tiny internal HTTP server - receives error notifications from the sandbox
// proxy container (which cannot call WhatsApp directly) and forwards them
// to the admin via notifyAdmin().
//
// Endpoint: POST /notify  { source: string, details: string }
// Binds to GEMIX_NOTIFY_BIND (loopback by default). The proxy container posts
// from inside Docker, so a deployment that wants those alerts binds this to the
// bridge gateway the container reaches as host.docker.internal.

import http from 'http';
import { createLogger  } from './logger.js';
import { notifyAdmin  } from './adminNotifier.js';
import env from '../config/env.js';

const log = createLogger('InternalNotify');

// Extract port from URL (e.g. http://172.17.0.1:9999/notify -> 9999)
let PORT = 9999;
if (env.GEMIX_NOTIFY_URL) {
  try {
    const u = new URL(env.GEMIX_NOTIFY_URL);
    if (u.port) PORT = parseInt(u.port, 10);
  } catch { /* fallback to 9999 */ }
}

const NOTIFY_SECRET = env.GEMIX_NOTIFY_SECRET || '';

let _server = null;

function startInternalNotifyServer() {
  if (_server) return;

  _server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404).end();
      return;
    }

    // Counted in bytes, not code units: the cap has to describe what was read
    // off the socket, and a multi-byte character split across chunks would
    // otherwise be decoded wrong on top of being miscounted.
    const chunks = [];
    let received = 0;
    const reply = (code, text) => {
      if (res.writableEnded || res.destroyed) return;
      try { res.writeHead(code).end(text); } catch { /* client already gone */ }
    };
    req.on('data', chunk => {
      received += chunk.length;
      if (received > 4096) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        if (NOTIFY_SECRET && req.headers['x-notify-secret'] !== NOTIFY_SECRET) {
          reply(403, 'forbidden');
          return;
        }
        const { source, details } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (source && details) {
          log.warn(`Proxy notification: [${source}] ${details}`);
          await notifyAdmin(String(source).slice(0, 100), String(details).slice(0, 500));
        }
        reply(200, 'ok');
      } catch {
        reply(400);
      }
    });
    req.on('error', () => reply(400));
  });

  _server.listen(PORT, env.GEMIX_NOTIFY_BIND, () => {
    log.info(`Internal notify server listening on ${env.GEMIX_NOTIFY_BIND}:${PORT}`);
  });

  _server.on('error', (err) => {
    log.warn(`Internal notify server error: ${err.message}`);
  });
}

async function stopInternalNotifyServer() {
  const server = _server;
  _server = null;
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

export { startInternalNotifyServer, stopInternalNotifyServer };
