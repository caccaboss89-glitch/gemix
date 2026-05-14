// src/utils/tempFileServer.js
// HTTP server that hosts temporary files with expiration.
// Files uploaded here are automatically deleted after 1 hour.
// Accessible externally to send temporary download links via WhatsApp/Discord.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const env = require('../config/env');
const { DATA_DIR } = require('../config/constants');

const log = createLogger('TempFileServer');

// Configuration
let PORT = 9998;
if (env.GEMIX_PUBLIC_URL) {
  try {
    const u = new URL(env.GEMIX_PUBLIC_URL);
    if (u.port) PORT = parseInt(u.port, 10);
  } catch { /* fallback to 9998 */ }
}
const EXPIRATION_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const TEMP_DIR = path.join(process.cwd(), '.tempfiles');

// In-memory registry: Map<tokenId, { token, filePath, expiresAt, originalName }>
const fileRegistry = new Map();

let _server = null;
let _cleanupInterval = null;

/**
 * Generate a secure random token for file access
 */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
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

/**
 * Register a file for temporary hosting
 * @param {string} filePath - Full path to the file
 * @param {string} originalName - Original filename to show in URL
 * @returns {object} { token, url, expiresAt, expiresInMinutes }
 */
function registerTempFile(filePath, originalName) {
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

    const token = generateToken();
    const expiresAt = Date.now() + EXPIRATION_MS;
    const expiresInMinutes = Math.round(EXPIRATION_MS / 60000);

    fileRegistry.set(token, {
      token,
      filePath,
      expiresAt,
      originalName: path.basename(originalName || filePath),
    });

    // Build URL: use env variable GEMIX_PUBLIC_URL if available, else fallback
    let publicUrl = env.GEMIX_PUBLIC_URL || 'http://localhost:9998';
    if (publicUrl === 'http://localhost:9998') {
      log.warn(`⚠️  GEMIX_PUBLIC_URL not set - temp links will be: ${publicUrl} (may not be accessible externally)`);
    }
    if (publicUrl.endsWith('/')) publicUrl = publicUrl.slice(0, -1);
    const url = `${publicUrl}/temp/${token}/${encodeURIComponent(path.basename(originalName || filePath))}`;

    log.info(`📁 Registered temp file: ${originalName} (token=${token.slice(0, 8)}..., expires in ${expiresInMinutes}min)`);

    return {
      token,
      url,
      expiresAt,
      expiresInMinutes,
    };
  } catch (err) {
    log.error(`❌ Failed to register temp file: ${err.message}`);
    throw err;
  }
}

/**
 * Cleanup expired files
 */
function cleanupExpiredFiles() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [token, entry] of fileRegistry.entries()) {
    if (entry.expiresAt <= now) {
      try {
        // Only delete if file is in our temp dir (safety check)
        const absPath = path.resolve(entry.filePath);
        const tempDirAbs = path.resolve(TEMP_DIR);
        // Guarantee cross-platform compatibility and exact boundary
        const sep = path.sep;
        const absPathLower = absPath.toLowerCase();
        const tempDirLower = tempDirAbs.toLowerCase();
        const isUnderTempDir = absPathLower === tempDirLower || absPathLower.startsWith(tempDirLower + sep);
        if (isUnderTempDir && fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          log.debug(`🗑️  Deleted expired temp file: ${entry.originalName}`);
        }
      } catch (err) {
        log.warn(`⚠️  Failed to delete expired file: ${err.message}`);
      }
      fileRegistry.delete(token);
      cleanedCount++;
    }
  }

  if (fs.existsSync(TEMP_DIR)) {
    try {
      const files = fs.readdirSync(TEMP_DIR);
      for (const file of files) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && now - stat.mtimeMs > EXPIRATION_MS) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        } catch { }
      }
    } catch { }
  }

  if (cleanedCount > 0) {
    log.info(`🧹 Cleanup: removed ${cleanedCount} expired/orphan file(s), ${fileRegistry.size} remaining in registry`);
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

        // Serve the file safely with escaped quotes and RFC 5987 UTF-8 encoding
        const escapedName = entry.originalName.replace(/"/g, '\\"');
        const encodedName = encodeURIComponent(entry.originalName);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${escapedName}"; filename*=UTF-8''${encodedName}`,
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
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
    log.info(`✅ Temp file server listening on 0.0.0.0:${PORT} (files expire after 1 hour)`);
  });

  _server.on('error', (err) => {
    log.error(`Temp file server error: ${err.message}`);
  });

  // Start periodic cleanup
  if (_cleanupInterval) clearInterval(_cleanupInterval);
  cleanupExpiredFiles();
  _cleanupInterval = setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_MS);
  if (_cleanupInterval.unref) _cleanupInterval.unref();
  log.info(`🔄 Cleanup scheduler started (runs every ${CLEANUP_INTERVAL_MS / 60000} minutes)`);
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
  getTempFileStats,
  cleanupExpiredFiles,
  TEMP_DIR,
};
