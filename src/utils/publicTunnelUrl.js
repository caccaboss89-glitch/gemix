// Resolves the public base URL for attachment tunnel links (xAI input_file, etc.).
//
// Source: src/data/tunnel-public-url.txt (written by scripts/run-attachment-tunnel.sh
// when localtunnel prints "your url is: …"). Fallback: http://localhost:9998.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const env = require('../config/env');
const { DATA_DIR } = require('../config/constants');

const log = createLogger('PublicTunnelUrl');

const DEFAULT_TUNNEL_URL_FILE = path.join(DATA_DIR, 'tunnel-public-url.txt');

let _fileUrlCache = null;
let _fileUrlMtime = 0;
let _missingFileWarned = false;

function _tunnelUrlFilePath() {
  const custom = env.GEMIX_TUNNEL_URL_FILE;
  if (typeof custom === 'string' && custom.trim()) {
    const trimmed = custom.trim();
    return path.isAbsolute(trimmed)
      ? trimmed
      : path.join(__dirname, '..', '..', trimmed);
  }
  return DEFAULT_TUNNEL_URL_FILE;
}

function _readUrlFromFile() {
  const filePath = _tunnelUrlFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (_fileUrlCache && st.mtimeMs === _fileUrlMtime) return _fileUrlCache;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const line = raw.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('http'));
    if (!line) return null;
    const normalized = line.replace(/\/+$/, '');
    new URL(normalized);
    _fileUrlCache = normalized;
    _fileUrlMtime = st.mtimeMs;
    return normalized;
  } catch (err) {
    log.warn(`Invalid tunnel URL file (${filePath}): ${err.message}`);
    return null;
  }
}

function getPublicBaseUrl() {
  try {
    fs.mkdirSync(path.dirname(DEFAULT_TUNNEL_URL_FILE), { recursive: true });
  } catch { /* ignore */ }

  const fromFile = _readUrlFromFile();
  if (fromFile) return fromFile;

  if (!_missingFileWarned) {
    _missingFileWarned = true;
    log.warn(
      `Tunnel URL file missing (${_tunnelUrlFilePath()}) — attachment links use localhost until the tunnel script writes it`,
    );
  }
  return 'http://localhost:9998';
}

module.exports = { getPublicBaseUrl, DEFAULT_TUNNEL_URL_FILE };