// src/utils/tempFileServer.js
// HTTP server that hosts temporary files with expiration.
//
// Serves the temporary download links sent to USERS when WhatsApp/Discord
// reject or cannot carry an attachment directly (delivery fallback, see
// utils/attachmentFallback.js). This server never feeds the model: what the
// model sees is inline base64 or a path it opens with read_file.
//
// It also owns the .tempfiles/ staging directory (tempDirForOwner), where
// per-user buffers are materialized before delivery and periodically swept.
//
// Each token is 128-bit random (crypto.randomBytes(16)). Listing is
// disabled (regex match on /temp/<32hex>/<name> only). Path traversal is
// blocked (registered files must live under constants.DATA_DIR or TEMP_DIR). Per-token
// rate limit caps abuse from leaked links.
//
// It listens on loopback only: the public path is Caddy, which terminates TLS
// and forwards just /temp/*. The host shares a home LAN with the family's own
// devices, so nothing here is offered to the local subnet directly.

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createLogger  } from './logger.js';
import { mimeForExtension  } from '../config/mimeExtensions.js';
import { getPublicBaseUrl  } from './publicTunnelUrl.js';
import envConfig from '../config/env.js';
import constants from '../config/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('TempFileServer');

// Configuration (GEMIX_TEMP_FILE_PORT is required — env.js fails fast if unset).
const PORT = envConfig.GEMIX_TEMP_FILE_PORT;
// Default TTL kept for backward compatibility (existing fallback callers
// did not pass ttlMs). Equivalent to constants.TUNNEL_TOKEN_TTL_TEMP_MS.
const DEFAULT_EXPIRATION_MS = constants.TUNNEL_TOKEN_TTL_TEMP_MS;
// Cleanup runs every 5 minutes regardless of TTL kind: a 24h token still
// needs deletion soon after its window closes.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// Absolute path to temp directory under the repo root (see .tempfiles/).
// Using an absolute path ensures consistency regardless of how the process
// is started (PM2, Docker, manual, etc.).
const TEMP_DIR = path.join(__dirname, '..', '..', '.tempfiles');

// In-memory registry: Map<token, {
//   token, filePath, expiresAt, originalName, mimetype, disposition, requestCount
// }>
const fileRegistry = new Map();

// Per-token request counter to mitigate token-reuse abuse / scraping.
// A legitimate recipient downloads a link once or twice (initial open +
// occasional retry) before we'd notice a problem, so 20 is generous without
// being permissive.
const MAX_TOKEN_REQUESTS = 20;

let _server = null;
let _cleanupInterval = null;

/**
 * Remove one-shot staging left by an earlier process. Its token registry was
 * in that process's memory, so none of these files can still be downloaded.
 * Durable chat history lives under DATA_DIR and is deliberately untouched.
 */
function clearTempStagingOnStartup(tempDir = TEMP_DIR) {
  fileRegistry.clear();
  if (!fs.existsSync(tempDir)) return false;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    log.info('Cleared temporary staging left by the previous process');
    return true;
  } catch (err) {
    log.warn(`Could not clear temporary staging left by the previous process: ${err.message}`);
    return false;
  }
}

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
    const absData = path.resolve(constants.DATA_DIR).toLowerCase().replace(/\\/g, '/');

    const isUnderTemp = absTarget === absTemp || absTarget.startsWith(absTemp + '/');
    const isUnderData = absTarget === absData || absTarget.startsWith(absData + '/');

    return isUnderTemp || isUnderData;
  } catch {
    return false;
  }
}

/**
 * Resolve a MIME type from the original filename (see mimeExtensions.js).
 * Unknown extensions fall back to application/octet-stream + attachment disposition.
 */
function _detectMime(originalName) {
  if (typeof originalName !== 'string' || !originalName) return 'application/octet-stream';
  const idx = originalName.lastIndexOf('.');
  if (idx < 0) return 'application/octet-stream';
  return mimeForExtension(originalName.slice(idx));
}

/**
 * Decide the Content-Disposition for a given MIME. Passive browser media and
 * plain text may render inline; unknown types and active documents such as
 * HTML, SVG and XML are downloads so they cannot execute on the tunnel origin.
 */
function _detectDisposition(mimetype) {
  const mime = String(mimetype || '').split(';', 1)[0].trim().toLowerCase();
  const safeInline = mime === 'application/pdf'
    || mime === 'text/plain'
    || mime.startsWith('audio/')
    || mime.startsWith('video/')
    || (mime.startsWith('image/') && mime !== 'image/svg+xml');
  return safeInline ? 'inline' : 'attachment';
}

/**
 * Register a file for temporary public hosting via the tunnel.
 *
 * @param {string} filePath - Absolute path to a file under constants.DATA_DIR or TEMP_DIR.
 * @param {string} originalName - Filename to expose in the URL and Content-Disposition.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - Override default TTL (default
 *   constants.TUNNEL_TOKEN_TTL_TEMP_MS = 1h). Pass constants.TUNNEL_TOKEN_TTL_HISTORY_MS for files
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
      throw new Error('Security check failed: path traversal attempt refused');
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
      requestCount: 0
    });

    const publicUrl = getPublicBaseUrl();
    if (publicUrl === 'http://localhost:9998') {
      log.warn(`No public tunnel URL - temp links will be ${publicUrl} (not reachable from outside)`);
    }
    const url = `${publicUrl}/temp/${token}/${encodeURIComponent(finalName)}`;

    log.info(`Registered temp file: ${finalName} (${stat.size} bytes, mime=${mimetype}, token=${token.slice(0, 8)}…, expires in ${expiresInMinutes}min)`);

    return {
      token,
      url,
      expiresAt,
      expiresInMinutes,
      mimetype
    };
  } catch (err) {
    log.error(`Failed to register temp file: ${err.message}`);
    throw err;
  }
}

/**
 * Cleanup expired tokens.
 *
 * Two layers:
 *   1. Drop expired entries from the in-memory registry. If the registered
 *      file lives under TEMP_DIR (one-shot artefact, not user-history) we
 *      also unlink it from disk; files anywhere else (constants.DATA_DIR/users/.../history,
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
      const orphanThresholdMs = constants.TUNNEL_TOKEN_TTL_HISTORY_MS;
      // Recurse one level deep: temp files live either in TEMP_DIR root
      // (callers without an owner) or in TEMP_DIR/<owner>/ (per-user isolation). Sweep
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
        //   - inline for passive media, PDF and plain text;
        //   - attachment for unknown types and active documents.
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
          'Referrer-Policy': 'no-referrer'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('error', (err) => {
          log.error(`Stream error for ${entry.originalName}: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500).end();
          } else {
            // Headers already sent with pipe: terminate so clients do not hang.
            res.destroy(err);
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

  _server.listen(PORT, '127.0.0.1', () => {
    const tempH = Math.round(constants.TUNNEL_TOKEN_TTL_TEMP_MS / 60000);
    const histH = Math.round(constants.TUNNEL_TOKEN_TTL_HISTORY_MS / 3600000);
    log.info(`Temp file server listening on 127.0.0.1:${PORT} (TTL: ${tempH}min temp / ${histH}h history)`);
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

export {
  startTempFileServer,
  clearTempStagingOnStartup,
  registerTempFile,
  tempDirForOwner,
  TEMP_DIR,
  _detectDisposition
};
