// src/utils/internalNotifyServer.js
// Tiny internal HTTP server - receives error notifications from the sandbox
// proxy container (which cannot call WhatsApp directly) and forwards them
// to the admin via notifyAdmin().
//
// Endpoint: POST /notify  { source: string, details: string }
// Only binds to 127.0.0.1 - reachable from Docker via host.docker.internal.

const http = require('http');
const { createLogger } = require('./logger');
const { notifyAdmin } = require('./adminNotifier');
const env = require('../config/env');

const log = createLogger('InternalNotify');
 
// Extract port from URL (e.g. http://172.17.0.1:9999/notify -> 9999)
let PORT = 9999;
if (env.GEMIX_NOTIFY_URL) {
  try {
    const u = new URL(env.GEMIX_NOTIFY_URL);
    if (u.port) PORT = parseInt(u.port, 10);
  } catch { /* fallback to 9999 */ }
}

let _server = null;

function startInternalNotifyServer() {
  if (_server) return;

  _server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { source, details } = JSON.parse(body);
        if (source && details) {
          log.warn(`Proxy notification: [${source}] ${details}`);
          await notifyAdmin(String(source).slice(0, 100), String(details).slice(0, 500));
        }
        res.writeHead(200).end('ok');
      } catch {
        res.writeHead(400).end();
      }
    });
    req.on('error', () => res.writeHead(400).end());
  });

  _server.listen(PORT, '127.0.0.1', () => {
    log.info(`Internal notify server listening on 127.0.0.1:${PORT}`);
  });

  _server.on('error', (err) => {
    log.warn(`Internal notify server error: ${err.message}`);
  });
}

module.exports = { startInternalNotifyServer };
