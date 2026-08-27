// Shared request/response dumps for every API path GemiX owns. Main-brain
// Responses calls and the xAI media stack write into the same ignored runtime
// directory, with a common 30-day retention policy.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = createLogger('APILogs');
const DEFAULT_LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token)$/i;
const BASE64_KEY = /^(file_data|b64_json|image_base64|audio_base64)$/i;

function _redactedBlob(value, label = 'data') {
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return `<${label} omitted: ${value.length} chars, sha256=${hash}>`;
}

/** Clone API data for disk without retaining credentials or large opaque blobs. */
function redactApiLogData(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') {
    if (key === 'encrypted_content') return _redactedBlob(value, 'encrypted_content');
    const comma = value.indexOf(',');
    if (/^data:[^;]+;base64,/i.test(value) && comma !== -1) {
      return `${value.slice(0, comma + 1)}${_redactedBlob(value.slice(comma + 1), 'base64')}`;
    }
    if (BASE64_KEY.test(key) && value.length > 128) return _redactedBlob(value, key);
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    return `<binary omitted: ${buffer.length} bytes, sha256=${hash}>`;
  }
  if (Array.isArray(value)) return value.map(child => redactApiLogData(child));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, redactApiLogData(child, childKey)])
    );
  }
  return value;
}

class ApiLogStore {
  constructor(opts = {}) {
    this.logDir = opts.logDir || DEFAULT_LOG_DIR;
    this.now = opts.now || (() => Date.now());
    this._cleanupInterval = null;
  }

  _ensureDir() {
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
  }

  _filePath(kind, timestamp) {
    const sanitized = timestamp.replace(/[:.]/g, '-');
    const random = crypto.randomBytes(4).toString('hex');
    return path.join(this.logDir, `api-${kind}-${sanitized}-${random}.json`);
  }

  write(kind, bodyField, modelName, apiUrl, body, extra = {}) {
    try {
      this._ensureDir();
      const timestamp = new Date(this.now()).toISOString();
      const entry = redactApiLogData({
        timestamp,
        model: modelName,
        apiUrl,
        [bodyField]: body,
        ...extra
      });
      const filePath = this._filePath(kind, timestamp);
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      return filePath;
    } catch (err) {
      log.warn(`Failed to write API ${kind} log: ${err.message}`);
      return null;
    }
  }

  cleanupOldLogs() {
    try {
      if (!fs.existsSync(this.logDir)) return 0;
      const now = this.now();
      let deleted = 0;
      for (const file of fs.readdirSync(this.logDir)) {
        if (!file.endsWith('.json') && !file.endsWith('.json.tmp')) continue;
        const filePath = path.join(this.logDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && now - stat.mtimeMs > LOG_MAX_AGE_MS) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* a concurrent writer or cleanup may already have moved it */ }
      }
      if (deleted > 0) log.info(`Log cleanup: deleted ${deleted} file(s) older than 30 days.`);
      return deleted;
    } catch (err) {
      log.warn(`Log cleanup failed: ${err.message}`);
      return 0;
    }
  }

  initRetention() {
    if (this._cleanupInterval) return;
    this.cleanupOldLogs();
    this._cleanupInterval = setInterval(() => this.cleanupOldLogs(), LOG_CLEANUP_INTERVAL_MS);
    this._cleanupInterval.unref();
  }
}

const apiLogStore = new ApiLogStore();

const logApiRequest = (modelName, apiUrl, body, extra = {}) =>
  apiLogStore.write('request', 'requestBody', modelName, apiUrl, body, extra);
const logApiResponse = (modelName, apiUrl, body, extra = {}) =>
  apiLogStore.write('response', 'responseBody', modelName, apiUrl, body, extra);
const initApiLogRetention = () => apiLogStore.initRetention();

export {
  ApiLogStore,
  LOG_MAX_AGE_MS,
  initApiLogRetention,
  logApiRequest,
  logApiResponse,
  redactApiLogData
};
