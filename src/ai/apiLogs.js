// Shared request/response dumps for every API path GemiX owns. Main-brain
// Responses calls and the xAI media stack write into the same ignored runtime
// directory, with a common 30-day retention policy.

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
const CONVERSATION_DIR = 'conversations';
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
    this._conversationContext = new AsyncLocalStorage();
    this._conversationEpochs = new Map();
  }

  _ensureDir(dir = this.logDir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** A fixed-width filesystem-safe directory that never embeds the raw conversation id. */
  _conversationHash(conversationKey) {
    if (typeof conversationKey !== 'string' || !conversationKey.trim()) return null;
    return crypto.createHash('sha256').update(`gemix-api-log\0${conversationKey}`).digest('hex');
  }

  _conversationDir(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash || '')) return null;
    return path.join(this.logDir, CONVERSATION_DIR, hash);
  }

  _currentConversation() {
    const context = this._conversationContext.getStore();
    if (!context) return null;
    const currentEpoch = this._conversationEpochs.get(context.hash) || 0;
    return context.epoch === currentEpoch ? context : null;
  }

  _filePath(kind, timestamp, conversation = null) {
    const sanitized = timestamp.replace(/[:.]/g, '-');
    const random = crypto.randomBytes(4).toString('hex');
    const dir = conversation ? this._conversationDir(conversation.hash) : this.logDir;
    if (!dir) return null;
    return path.join(dir, `api-${kind}-${sanitized}-${random}.json`);
  }

  write(kind, bodyField, modelName, apiUrl, body, extra = {}) {
    try {
      const asyncContext = this._conversationContext.getStore();
      const conversation = this._currentConversation();
      // A wipe increments the epoch. Any request that started before it keeps
      // the old async context, so a late response cannot recreate deleted logs.
      if (asyncContext && !conversation) return null;
      const timestamp = new Date(this.now()).toISOString();
      const entry = redactApiLogData({
        timestamp,
        model: modelName,
        apiUrl,
        [bodyField]: body,
        ...extra
      });
      const filePath = this._filePath(kind, timestamp, conversation);
      if (!filePath) return null;
      this._ensureDir(path.dirname(filePath));
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      return filePath;
    } catch (err) {
      log.warn(`Failed to write API ${kind} log: ${err.message}`);
      return null;
    }
  }

  /**
   * Run one complete conversation turn under a stable log scope. The raw key is
   * never used as a path or written to the directory index.
   */
  withConversation(conversationKey, fn) {
    if (typeof fn !== 'function') throw new TypeError('withConversation requires a callback.');
    const hash = this._conversationHash(conversationKey);
    if (!hash) return fn();
    const epoch = this._conversationEpochs.get(hash) || 0;
    return this._conversationContext.run({ hash, epoch }, fn);
  }

  /** Count retained log files below one already-resolved conversation root. */
  _countLogFiles(dir) {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) count += this._countLogFiles(entryPath);
        else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.json.tmp'))) count++;
      }
    } catch { /* missing or concurrently removed is already empty */ }
    return count;
  }

  /**
   * Delete exactly one conversation's API logs. Incrementing the in-memory
   * epoch first also suppresses late writes from a turn already in flight.
   */
  deleteConversation(conversationKey) {
    const hash = this._conversationHash(conversationKey);
    if (!hash) return { ok: false, deleted: 0 };
    this._conversationEpochs.set(hash, (this._conversationEpochs.get(hash) || 0) + 1);
    const dir = this._conversationDir(hash);
    if (!dir) return { ok: false, deleted: 0 };
    const deleted = this._countLogFiles(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, deleted };
    } catch (err) {
      log.warn(`Failed to delete conversation API logs: ${err.message}`);
      return { ok: false, deleted: 0 };
    }
  }

  /**
   * Move flat main-brain logs written before conversation scoping into the new
   * hashed layout. Request/response pairs share apiLogId; the request's canonical
   * prompt_cache_key supplies the scope. Unrelated media logs remain untouched.
   */
  migrateLegacyConversationLogs() {
    if (!fs.existsSync(this.logDir)) return 0;
    let entries;
    try {
      entries = fs.readdirSync(this.logDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'));
    } catch (err) {
      log.warn(`Legacy API log discovery failed: ${err.message}`);
      return 0;
    }

    const records = [];
    const scopeByApiLogId = new Map();
    for (const entry of entries) {
      const source = path.join(this.logDir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
        const apiLogId = typeof parsed?.apiLogId === 'string' ? parsed.apiLogId : null;
        const conversationKey = typeof parsed?.requestBody?.prompt_cache_key === 'string'
          ? parsed.requestBody.prompt_cache_key
          : null;
        if (apiLogId && conversationKey) scopeByApiLogId.set(apiLogId, conversationKey);
        records.push({ source, name: entry.name, apiLogId, conversationKey });
      } catch { /* incomplete or non-JSON files stay under normal retention */ }
    }

    let migrated = 0;
    for (const record of records) {
      const conversationKey = record.conversationKey || scopeByApiLogId.get(record.apiLogId);
      const hash = this._conversationHash(conversationKey);
      const dir = this._conversationDir(hash);
      if (!dir) continue;
      try {
        this._ensureDir(dir);
        fs.renameSync(record.source, path.join(dir, record.name));
        migrated++;
      } catch (err) {
        // A concurrent startup may already have moved it; a persistent failure
        // still needs to be visible because that file remains outside its scope.
        if (fs.existsSync(record.source)) {
          log.warn(`Legacy API log migration failed for ${record.name}: ${err.message}`);
        }
      }
    }
    if (migrated > 0) log.info(`Log migration: scoped ${migrated} legacy request/response file(s).`);
    return migrated;
  }

  _cleanupDirectory(dir, now, removeWhenEmpty = false) {
    let deleted = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return deleted; }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        deleted += this._cleanupDirectory(entryPath, now, true);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.endsWith('.json.tmp'))) continue;
      try {
        const stat = fs.statSync(entryPath);
        if (now - stat.mtimeMs > LOG_MAX_AGE_MS) {
          fs.unlinkSync(entryPath);
          deleted++;
        }
      } catch { /* a concurrent writer or cleanup may already have moved it */ }
    }
    if (removeWhenEmpty) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* directory changed or was already removed */ }
    }
    return deleted;
  }

  cleanupOldLogs() {
    try {
      if (!fs.existsSync(this.logDir)) return 0;
      const now = this.now();
      const deleted = this._cleanupDirectory(this.logDir, now);
      if (deleted > 0) log.info(`Log cleanup: deleted ${deleted} file(s) older than 30 days.`);
      return deleted;
    } catch (err) {
      log.warn(`Log cleanup failed: ${err.message}`);
      return 0;
    }
  }

  initRetention() {
    if (this._cleanupInterval) return;
    this.migrateLegacyConversationLogs();
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
const withApiLogConversation = (conversationKey, fn) => apiLogStore.withConversation(conversationKey, fn);
const deleteApiLogsForConversation = (conversationKey) => apiLogStore.deleteConversation(conversationKey);

export {
  ApiLogStore,
  LOG_MAX_AGE_MS,
  deleteApiLogsForConversation,
  initApiLogRetention,
  logApiRequest,
  logApiResponse,
  redactApiLogData,
  withApiLogConversation
};
