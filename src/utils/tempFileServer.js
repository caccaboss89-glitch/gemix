// src/utils/tempFileServer.js
// HTTP server that hosts temporary files with expiration.
//
// Two access patterns:
//   1. Fallback delivery: temp links sent to the user when WhatsApp/Discord
//      reject the attachment (legacy behaviour, 1h TTL).
//   2. xAI ingestion: public URLs handed to /v1/responses as `input_file`
//      so Grok can fetch PDF/audio/video/text natively. xAI fetches the
//      file once shortly after the request - short-lived tokens are fine
//      for buffer-backed assets, longer ones (24h) for files already living
//      in chat history that may be re-referenced across turns.
//
// Each token is 128-bit random (crypto.randomBytes(16)). Listing is
// disabled (regex match on /temp/<32hex>/<name> only). Path traversal is
// blocked (registered files must live under DATA_DIR or TEMP_DIR). Per-token
// rate limit caps abuse from leaked links.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const env = require('../config/env');
const {
  DATA_DIR,
  TUNNEL_TOKEN_TTL_HISTORY_MS,
  TUNNEL_TOKEN_TTL_TEMP_MS,
} = require('../config/constants');

const log = createLogger('TempFileServer');

// Configuration
let PORT = 9998;
if (env.GEMIX_PUBLIC_URL) {
  try {
    const u = new URL(env.GEMIX_PUBLIC_URL);
    if (u.port) PORT = parseInt(u.port, 10);
  } catch { /* fallback to 9998 */ }
}
// Default TTL kept for backward compatibility (existing fallback callers
// did not pass ttlMs). Equivalent to TUNNEL_TOKEN_TTL_TEMP_MS.
const DEFAULT_EXPIRATION_MS = TUNNEL_TOKEN_TTL_TEMP_MS;
// Cleanup runs every 5 minutes regardless of TTL kind: a 24h token still
// needs deletion soon after its window closes.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// Absolute path to temp directory. On the VPS this resolves to
// /home/ubuntu/DiscordBots/GemiX/.tempfiles (or wherever GemiX is deployed).
// Using an absolute path ensures consistency regardless of how the process
// is started (PM2, Docker, manual, etc.).
const TEMP_DIR = path.join(__dirname, '..', '..', '.tempfiles');

// In-memory registry: Map<token, {
//   token, filePath, expiresAt, originalName, mimetype, disposition, requestCount
// }>
const fileRegistry = new Map();

// Per-token request counter to mitigate token-reuse abuse / scraping.
// xAI fetches the file once or twice (initial download + occasional re-fetch),
// the user downloads it once or twice from a leaked link before we'd notice,
// so 20 is generous without being permissive.
const MAX_TOKEN_REQUESTS = 20;

let _server = null;
let _cleanupInterval = null;

/**
 * Generate a secure random token for file access
 */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Sanitize an owner key (workspace slug, user id, ...) into a single safe path
 * segment so per-user temp files can live in their own subdir under TEMP_DIR.
 * Returns null for empty/invalid input (caller falls back to TEMP_DIR root).
 */
function _ownerSegment(ownerKey) {
  if (typeof ownerKey !== 'string') return null;
  const seg = ownerKey.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return seg || null;
}

/**
 * Resolve the directory a temp file should be written to. With an ownerKey
 * the file lands in TEMP_DIR/<owner>/ (per-user physical isolation); without
 * one it stays in TEMP_DIR root (back-compat for callers with no user ctx).
 * The directory is created on demand.
 */
function tempDirForOwner(ownerKey) {
  const seg = _ownerSegment(ownerKey);
  const dir = seg ? path.join(TEMP_DIR, seg) : TEMP_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _isAllowedPath(target) {
  try {
    const absTarget = path.resolve(target).toLowerCase().replace(/\\/g, '/');
    const absTemp = path.resolve(TEMP_DIR).toLowerCase().replace(/\\/g, '/');
    const absData = path.resolve(DATA_DIR).toLowerCase().replace(/\\/g, '/');
    
    const isUnderTemp = absTarget === absTemp || absTarget.startsWith(absTemp + '/');
    const isUnderData = absTarget === absData || absTarget.startsWith(absData + '/');
    
    return isUnderTemp || isUnderData;
  } catch {
    return false;
  }
}

// MIME map for the kinds of attachments xAI ingests via input_file. Kept
// minimal on purpose: any extension not in this table falls back to
// application/octet-stream + Content-Disposition: attachment, which forces
// download (safe default) but xAI may then refuse the file. Extending this
// table is the supported way to enable a new attachment type.
const MIME_BY_EXT = {
  // Documents
  '.pdf': 'application/pdf',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  // Plain text & code (xAI accepts these as input_file too)
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
};

/**
 * Resolve a MIME type from the original filename. Falls back to
 * application/octet-stream when the extension is unknown.
 */
function _detectMime(originalName) {
  if (typeof originalName !== 'string' || !originalName) return 'application/octet-stream';
  const idx = originalName.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  const ext = originalName.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Decide the Content-Disposition for a given MIME. Inline for everything
 * xAI is expected to fetch and parse (PDF, images, audio, video, text);
 * attachment for unknown types so that a leaked link triggers a download
 * dialog and not e.g. arbitrary execution in a browser.
 */
function _detectDisposition(mimetype) {
  if (mimetype === 'application/octet-stream') return 'attachment';
  return 'inline';
}

/**
 * Register a file for temporary public hosting via the tunnel.
 *
 * @param {string} filePath - Absolute path to a file under DATA_DIR or TEMP_DIR.
 * @param {string} originalName - Filename to expose in the URL and Content-Disposition.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - Override default TTL (default
 *   TUNNEL_TOKEN_TTL_TEMP_MS = 1h). Pass TUNNEL_TOKEN_TTL_HISTORY_MS for files
 *   from chat history that may be re-fetched across multiple turns.
 * @param {string} [opts.mimetype] - Override auto-detected MIME (rare; the
 *   default detection from extension is usually correct).
 * @param {'inline'|'attachment'} [opts.disposition] - Override Content-Disposition.
 * @returns {{token: string, url: string, expiresAt: number, expiresInMinutes: number, mimetype: string}}
 */
function registerTempFile(filePath, originalName, opts = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!_isAllowedPath(filePath)) {
      throw new Error(`Security check failed: path traversal attempt refused`);
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      throw new Error('Cannot register directory as temp file');
    }

    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
      ? opts.ttlMs
      : DEFAULT_EXPIRATION_MS;

    const finalName = originalName ? path.basename(originalName) : path.basename(filePath);
    const mimetype = opts.mimetype || _detectMime(finalName);
    const disposition = opts.disposition || _detectDisposition(mimetype);

    const token = generateToken();
    const expiresAt = Date.now() + ttlMs;
    const expiresInMinutes = Math.round(ttlMs / 60000);

    fileRegistry.set(token, {
      token,
      filePath,
      expiresAt,
      originalName: finalName,
      mimetype,
      disposition,
      requestCount: 0,
    });

    // Build URL: use env variable GEMIX_PUBLIC_URL if available, else fallback
    let publicUrl = env.GEMIX_PUBLIC_URL || 'http://localhost:9998';
    if (publicUrl === 'http://localhost:9998') {
      log.warn(`GEMIX_PUBLIC_URL not set - temp links will be: ${publicUrl} (may not be accessible externally)`);
    }
    if (publicUrl.endsWith('/')) publicUrl = publicUrl.slice(0, -1);
    const url = `${publicUrl}/temp/${token}/${encodeURIComponent(finalName)}`;

    log.info(`Registered temp file: ${finalName} (mime=${mimetype}, token=${token.slice(0, 8)}..., expires in ${expiresInMinutes}min)`);

    return {
      token,
      url,
      expiresAt,
      expiresInMinutes,
      mimetype,
    };
  } catch (err) {
    log.error(`Failed to register temp file: ${err.message}`);
    throw err;
  }
}

/**
 * Convenience wrapper for the new attachment-passing strategy.
 *
 * Use this when handing a file to xAI as `input_file` on /v1/responses, or
 * when emitting a public link for any other consumer. The function always
 * returns an HTTPS URL backed by the localtunnel reverse proxy (provided
 * GEMIX_PUBLIC_URL is set; falls back to localhost otherwise).
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {string} originalName - Display name (used in URL and headers).
 * @param {object} [opts]
 * @param {'history'|'temp'} [opts.kind='temp'] - Picks the default TTL:
 *   'history' - 24h (file lives on disk indefinitely, may be re-fetched),
 *   'temp'    - 1h  (one-shot generated asset or freshly-downloaded media).
 * @param {number} [opts.ttlMs] - Explicit override (takes precedence over kind).
 * @param {string} [opts.mimetype] - Force-override the detected MIME.
 * @returns {{url: string, token: string, expiresAt: number, mimetype: string}}
 */
function getPublicAttachmentUrl(filePath, originalName, opts = {}) {
  const kind = opts.kind === 'history' ? 'history' : 'temp';
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? opts.ttlMs
    : (kind === 'history' ? TUNNEL_TOKEN_TTL_HISTORY_MS : TUNNEL_TOKEN_TTL_TEMP_MS);
  return registerTempFile(filePath, originalName, {
    ttlMs,
    mimetype: opts.mimetype,
    disposition: opts.disposition,
  });
}

/**
 * Cleanup expired tokens.
 *
 * Two layers:
 *   1. Drop expired entries from the in-memory registry. If the registered
 *      file lives under TEMP_DIR (one-shot artefact, not user-history) we
 *      also unlink it from disk; files anywhere else (DATA_DIR/users/.../history,
 *      ...) are left intact because their lifecycle is owned by the history
 *      pruner / project sweeper, not us.
 *   2. Sweep TEMP_DIR for orphan files older than the longest possible TTL
 *      (history TTL - strictly an upper bound). This catches buffers that
 *      were written to disk but never registered or whose registry entry
 *      crashed before insertion.
 */
function cleanupExpiredFiles() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [token, entry] of fileRegistry.entries()) {
    if (entry.expiresAt <= now) {
      try {
        const absPath = path.resolve(entry.filePath);
        const tempDirAbs = path.resolve(TEMP_DIR);
        const sep = path.sep;
        const absPathLower = absPath.toLowerCase();
        const tempDirLower = tempDirAbs.toLowerCase();
        const isUnderTempDir = absPathLower === tempDirLower || absPathLower.startsWith(tempDirLower + sep);
        // Only delete files under our private temp dir. Files registered
        // from history live there forever (until the history pruner removes
        // them); deleting on token expiry would lose user content.
        if (isUnderTempDir && fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          log.debug(`🗑️  Deleted expired temp file: ${entry.originalName}`);
        }
      } catch (err) {
        log.warn(`Failed to delete expired file: ${err.message}`);
      }
      fileRegistry.delete(token);
      cleanedCount++;
    }
  }

  if (fs.existsSync(TEMP_DIR)) {
    try {
      const orphanThresholdMs = TUNNEL_TOKEN_TTL_HISTORY_MS;
      // Recurse one level deep: temp files now live either in TEMP_DIR root
      // (legacy callers) or in TEMP_DIR/<owner>/ (per-user isolation). Sweep
      // both, and drop owner subdirs once they go empty.
      const entries = fs.readdirSync(TEMP_DIR, { withFileTypes: true });
      for (const ent of entries) {
        const entPath = path.join(TEMP_DIR, ent.name);
        try {
          if (ent.isDirectory()) {
            const inner = fs.readdirSync(entPath);
            for (const f of inner) {
              const fp = path.join(entPath, f);
              try {
                const st = fs.statSync(fp);
                if (st.isFile() && now - st.mtimeMs > orphanThresholdMs) {
                  fs.unlinkSync(fp);
                  cleanedCount++;
                }
              } catch { }
            }
            // Remove the owner dir if it is now empty.
            try { if (fs.readdirSync(entPath).length === 0) fs.rmdirSync(entPath); } catch { }
          } else if (ent.isFile()) {
            const st = fs.statSync(entPath);
            if (now - st.mtimeMs > orphanThresholdMs) {
              fs.unlinkSync(entPath);
              cleanedCount++;
            }
          }
        } catch { }
      }
    } catch { }
  }

  if (cleanedCount > 0) {
    log.info(`Cleanup: removed ${cleanedCount} expired/orphan file(s), ${fileRegistry.size} remaining in registry`);
  }
}

/**
 * Start the temporary file server
 */
function startTempFileServer() {
  if (_server) {
    log.warn('Temp file server already running');
    return;
  }

  // Ensure temp dir exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  _server = http.createServer((req, res) => {
    // -- Access log --
    // Lightweight per-request log so we can verify xAI (or any client)
    // actually reaches us. If a fetch is registered in the bot but no
    // matching access log appears here, the request never made it past
    // the public tunnel (e.g. localtunnel anti-abuse warning page).
    const _start = Date.now();
    const _ua = (req.headers['user-agent'] || '-').toString().slice(0, 80);
    const _xff = req.headers['x-forwarded-for'];
    const _ip = (typeof _xff === 'string' && _xff
      ? _xff.split(',')[0].trim()
      : (req.socket && req.socket.remoteAddress) || '-');
    res.on('finish', () => {
      const _dur = Date.now() - _start;
      log.info(`HTTP ${req.method} ${req.url} - ${res.statusCode} (${_dur}ms, ua="${_ua}", ip=${_ip})`);
    });

    try {
      // Only handle GET requests to /temp/...
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method Not Allowed');
        return;
      }

      const urlMatch = req.url.match(/^\/temp\/([a-f0-9]{32})\//);
      if (!urlMatch) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
        return;
      }

      const token = urlMatch[1];
      const entry = fileRegistry.get(token);

      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('File not found or expired');
        return;
      }

      if (entry.expiresAt <= Date.now()) {
        fileRegistry.delete(token);
        res.writeHead(410, { 'Content-Type': 'text/plain' }).end('File expired');
        return;
      }

      // Per-token request cap. Legitimate recipients download once or twice;
      // anything beyond MAX_TOKEN_REQUESTS is treated as abuse (e.g. scrapers
      // following a leaked link, retries from broken clients) and refused.
      entry.requestCount = (entry.requestCount || 0) + 1;
      if (entry.requestCount > MAX_TOKEN_REQUESTS) {
        log.warn(`Rate-limit hit for temp token ${token.slice(0, 8)}... (${entry.requestCount} requests)`);
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '3600' }).end('Too many requests');
        return;
      }

      const filePath = entry.filePath;

      // Safety check: file must exist and be inside allowed temp dir
      if (!fs.existsSync(filePath) || !_isAllowedPath(filePath)) {
        fileRegistry.delete(token);
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('File not found');
        return;
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Is a directory');
          return;
        }

        // Build Content-Disposition with quote escaping + RFC 5987 UTF-8.
        // Disposition mode (inline vs attachment) was decided at registration:
        //   - inline for media xAI ingests (PDF/audio/video/image/text),
        //   - attachment for unknown types (download dialog, defensive).
        const escapedName = entry.originalName.replace(/"/g, '\\"');
        const encodedName = encodeURIComponent(entry.originalName);
        const disposition = entry.disposition || 'attachment';
        const mimetype = entry.mimetype || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mimetype,
          'Content-Disposition': `${disposition}; filename="${escapedName}"; filename*=UTF-8''${encodedName}`,
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          // Discourage search engines and link-preview crawlers from indexing
          // accidentally-leaked links.
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
          'Referrer-Policy': 'no-referrer',
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('error', (err) => {
          log.error(`Stream error for ${entry.originalName}: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500).end();
          }
        });
      } catch (err) {
        log.error(`Failed to serve temp file: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
      }
    } catch (err) {
      log.error(`Temp file server request error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  });

  _server.listen(PORT, '0.0.0.0', () => {
    const tempH = Math.round(TUNNEL_TOKEN_TTL_TEMP_MS / 60000);
    const histH = Math.round(TUNNEL_TOKEN_TTL_HISTORY_MS / 3600000);
    log.info(`Temp file server listening on 0.0.0.0:${PORT} (TTL: ${tempH}min temp / ${histH}h history)`);
  });

  _server.on('error', (err) => {
    log.error(`Temp file server error: ${err.message}`);
  });

  // Start periodic cleanup
  if (_cleanupInterval) clearInterval(_cleanupInterval);
  cleanupExpiredFiles();
  _cleanupInterval = setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
  if (_cleanupInterval.unref) _cleanupInterval.unref();
  log.info(`Cleanup scheduler started (runs every ${CLEANUP_INTERVAL_MS / 60000} minutes)`);
}

/**
 * Stop the temporary file server
 */
function stopTempFileServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }
  log.info('Temp file server stopped');
}

/**
 * Get stats about registered temp files
 */
function getTempFileStats() {
  const now = Date.now();
  let activeCount = 0;
  let expiredCount = 0;
  let totalBytes = 0;

  for (const [token, entry] of fileRegistry.entries()) {
    if (entry.expiresAt > now) {
      activeCount++;
      try {
        if (fs.existsSync(entry.filePath)) {
          const stat = fs.statSync(entry.filePath);
          totalBytes += stat.size;
        }
      } catch { /* ignore */ }
    } else {
      expiredCount++;
    }
  }

  return {
    active: activeCount,
    expired: expiredCount,
    totalBytes,
    tempDirSize: getDirectorySize(TEMP_DIR),
  };
}

/**
 * Get size of a directory recursively
 */
function getDirectorySize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let size = 0;
  try {
    const files = fs.readdirSync(dir, { recursive: true });
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          size += stat.size;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return size;
}

module.exports = {
  startTempFileServer,
  stopTempFileServer,
  registerTempFile,
  getPublicAttachmentUrl,
  tempDirForOwner,
  getTempFileStats,
  cleanupExpiredFiles,
  TEMP_DIR,
};
