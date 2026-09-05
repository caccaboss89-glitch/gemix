// src/utils/historySync.js
//
// Handles persistent storage of user/group chat history files, deterministic
// pruning of unreferenced attachments, and metadata for GemiX voice
// transcriptions. Also manages the short-lived voice text cache written when
// a voice reply is generated (matched to bot voice files in history).

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';
import { sanitizeFilename  } from './text.js';
import { withKeyedLock  } from './keyedLock.js';

const log = createLogger('HistorySync');

// Retention of the durable history store, shared with the workspace and the
// attachment projection so one conversation expires as a whole. See
// sweepHistoryStore for how it is applied.
const HISTORY_RETENTION_MS = constants.WORKSPACE_TTL_MS;
const GEMIX_VOICE_TEXT_CACHE_FILE = path.join(constants.DATA_DIR, 'gemixVoiceTextCache.json');
const RECENT_VOICE_MAX_ENTRIES = 200;
/** Match cache entry to history message time (voice sent vs history rebuild delay). */
const RECENT_VOICE_MATCH_TOLERANCE_MS = 120_000;
const RECENT_VOICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let recentVoiceEntries = [];
let recentVoiceEntriesLoaded = false;

/** Per-user chain: every read-modify-write of history_meta.json goes through it. */
const _syncLocks = new Map();

const _withSyncLock = (userId, fn) => withKeyedLock(_syncLocks, userId, fn);

/**
 * Get the history directory and meta file for a user.
 * @param {string} userId - Unique identifier for the user's folder
 * @returns {object} { historyDir, metaFile }
 */
function getUserHistoryPaths(userId) {
  const userDir = path.join(constants.DATA_DIR, 'users', userId);
  const historyDir = path.join(userDir, 'history');
  const metaFile = path.join(userDir, 'history_meta.json');
  return { historyDir, metaFile };
}

/**
 * Ensures the directory exists.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function _loadMeta(metaFile, userId) {
  let meta = {};
  try {
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
  } catch (err) {
    log.warn(`Failed to read history_meta.json for user ${userId}: ${err.message}`);
  }
  return meta && typeof meta === 'object' ? meta : {};
}

function _saveMeta(metaFile, meta, userId) {
  const tempFile = metaFile + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(meta, null, 2), 'utf-8');
    fs.renameSync(tempFile, metaFile);
    return true;
  } catch (err) {
    log.warn(`Failed to write history_meta.json for user ${userId}: ${err.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
    return false;
  }
}

function _getEntryFilename(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && typeof entry.filename === 'string') return entry.filename;
  return null;
}

function _normalizeHistoryFilename(historyFilename) {
  const raw = String(historyFilename || '').trim().replace(/\\/g, '/');
  return raw.startsWith('history/') ? raw.slice('history/'.length) : raw;
}

function _loadRecentVoiceEntries() {
  if (recentVoiceEntriesLoaded) return;
  recentVoiceEntriesLoaded = true;
  try {
    if (fs.existsSync(GEMIX_VOICE_TEXT_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(GEMIX_VOICE_TEXT_CACHE_FILE, 'utf-8'));
      recentVoiceEntries = Array.isArray(raw) ? raw : [];
    }
  } catch {
    recentVoiceEntries = [];
  }
}

function _ensureRecentVoiceEntriesLoaded() {
  if (!recentVoiceEntriesLoaded) _loadRecentVoiceEntries();
}

function _saveRecentVoiceEntries() {
  const tempFile = GEMIX_VOICE_TEXT_CACHE_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(recentVoiceEntries), 'utf-8');
    fs.renameSync(tempFile, GEMIX_VOICE_TEXT_CACHE_FILE);
  } catch {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
  }
}

function _cleanupRecentVoiceEntries() {
  _ensureRecentVoiceEntriesLoaded();
  const cutoff = Date.now() - RECENT_VOICE_MAX_AGE_MS;
  const before = recentVoiceEntries.length;
  recentVoiceEntries = recentVoiceEntries.filter(e => e && e.ts >= cutoff);
  if (recentVoiceEntries.length < before) _saveRecentVoiceEntries();
}

function storeRecentVoiceText(chatId, text, msgTimestampMs = null) {
  if (!chatId || !text) return;
  _cleanupRecentVoiceEntries();
  const ts = Number(msgTimestampMs) > 0 ? Number(msgTimestampMs) : Date.now();
  recentVoiceEntries.push({ chatId, ts, text });
  if (recentVoiceEntries.length > RECENT_VOICE_MAX_ENTRIES) {
    recentVoiceEntries = recentVoiceEntries.slice(-RECENT_VOICE_MAX_ENTRIES);
  }
  _saveRecentVoiceEntries();
}

/**
 * Drop every cached voice text for a chat (data wipe). The transcriptions
 * already persisted into history_meta.json go with the user's history folder.
 * @param {string} chatId
 * @returns {boolean} false when the rewrite failed
 */
function forgetRecentVoiceText(chatId) {
  if (!chatId) return true;
  _ensureRecentVoiceEntriesLoaded();
  const before = recentVoiceEntries.length;
  recentVoiceEntries = recentVoiceEntries.filter(e => !e || e.chatId !== chatId);
  if (recentVoiceEntries.length === before) return true;
  _saveRecentVoiceEntries();
  // _saveRecentVoiceEntries swallows write errors: re-read to confirm the
  // entries are really gone from disk before reporting the wipe as complete.
  try {
    if (!fs.existsSync(GEMIX_VOICE_TEXT_CACHE_FILE)) return true;
    const raw = JSON.parse(fs.readFileSync(GEMIX_VOICE_TEXT_CACHE_FILE, 'utf-8'));
    return !Array.isArray(raw) || !raw.some(e => e && e.chatId === chatId);
  } catch {
    return false;
  }
}

/**
 * The cached voice text closest in time to a message in the same chat.
 * @returns {{ index: number, text: string }|null}
 */
function _matchRecentVoiceText(chatId, msgTimestampMs) {
  if (!chatId || !msgTimestampMs) return null;
  _ensureRecentVoiceEntriesLoaded();
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < recentVoiceEntries.length; i++) {
    if (recentVoiceEntries[i].chatId !== chatId) continue;
    const diff = Math.abs(recentVoiceEntries[i].ts - msgTimestampMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestDiff > RECENT_VOICE_MATCH_TOLERANCE_MS) return null;
  return { index: bestIdx, text: recentVoiceEntries[bestIdx].text };
}

/** Drop one cached entry once its text has found its file for good. */
function _dropRecentVoiceEntry(index) {
  recentVoiceEntries.splice(index, 1);
  _saveRecentVoiceEntries();
}

/** The meta id and entry pointing at this stored filename, if there is one. */
function _findMetaEntry(meta, historyFilename) {
  for (const [id, entry] of Object.entries(meta)) {
    if (_getEntryFilename(entry) === historyFilename) {
      return { id, entry };
    }
  }
  return { id: null, entry: null };
}

/**
 * The meta entry for one stored file, loaded from disk.
 * @returns {object|null} null when the user, the name or the entry is missing
 */
function _loadEntryForFile(userId, historyFilename) {
  const normalized = _normalizeHistoryFilename(historyFilename);
  if (!userId || !normalized) return null;
  const { metaFile } = getUserHistoryPaths(userId);
  return _findMetaEntry(_loadMeta(metaFile, userId), normalized).entry;
}

function _upsertMetaEntry(meta, historyFilename) {
  const normalized = _normalizeHistoryFilename(historyFilename);
  if (!normalized) return { id: null, entry: null, normalized: null };
  const found = _findMetaEntry(meta, normalized);
  const id = found.id || `file:${normalized}`;
  const base = found.entry && typeof found.entry === 'object'
    ? found.entry
    : { filename: normalized };
  meta[id] = { ...base, filename: normalized };
  return { id, entry: meta[id], normalized };
}

/** Read, mutate and atomically rewrite one user's metadata under its lock. */
function _mutateMeta(userId, mutate, afterSave = null) {
  return _withSyncLock(userId, async () => {
    const { metaFile } = getUserHistoryPaths(userId);
    ensureDir(path.dirname(metaFile));
    const meta = _loadMeta(metaFile, userId);
    const changed = mutate(meta);
    if (changed === false) return false;
    const saved = _saveMeta(metaFile, meta, userId);
    if (saved && afterSave) afterSave();
    return saved;
  });
}

function getStoredHistoryVoiceTranscription(userId, historyFilename) {
  const text = _loadEntryForFile(userId, historyFilename)?.voiceTranscription?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/**
 * Stored transcription of a USER voice note, valid only for the exact bytes,
 * configured STT route and language hint that produced it.
 *
 * The complete fingerprint keeps the cache safe across a re-sent clip, route
 * change or language change: any difference is a miss rather than a stale
 * transcript attributed to the wrong audio or decoding setup.
 *
 * @param {string} userId
 * @param {string} historyFilename
 * @param {{contentHash?: string, routeId?: string, language?: string}} fingerprint
 * @returns {{ text: string, status: string }|null}
 */
function getStoredUserTranscription(userId, historyFilename, fingerprint = {}) {
  const stored = _loadEntryForFile(userId, historyFilename)?.userTranscription;
  if (!stored || typeof stored !== 'object') return null;
  if (fingerprint.contentHash && stored.contentHash !== fingerprint.contentHash) return null;
  if (fingerprint.routeId && stored.routeId !== fingerprint.routeId) return null;
  if ((fingerprint.language || '') !== (stored.language || '')) return null;
  return { text: typeof stored.text === 'string' ? stored.text : '', status: stored.status || 'ok' };
}

/**
 * Persist an outcome selected by the caller. Voice projection stores only
 * deterministic results; timeouts and service failures must be retried later.
 *
 * @param {string} userId
 * @param {string} historyFilename
 * @param {{ text?: string, status: string, provider?: string, model?: string, contentHash?: string, routeId?: string, language?: string }} record
 * @returns {Promise<boolean>}
 */
async function storeUserTranscription(userId, historyFilename, record) {
  if (!userId || !historyFilename || !record || !record.status) return false;
  return _mutateMeta(userId, (meta) => {
    const target = _upsertMetaEntry(meta, historyFilename);
    if (!target.id || !target.normalized) return false;
    meta[target.id] = {
      ...target.entry,
      userTranscription: {
        text: typeof record.text === 'string' ? record.text.trim() : '',
        status: record.status,
        provider: record.provider || '',
        model: record.model || '',
        contentHash: record.contentHash || '',
        routeId: record.routeId || '',
        language: record.language || '',
        updatedAt: Date.now()
      }
    };
  });
}

/**
 * Bind a GemiX voice file to the text of the reply that produced it. Reads the
 * durable metadata first; otherwise claims the closest entry from the short
 * generation-time cache and persists it before releasing that cache entry.
 *
 * @returns {Promise<string|null>} the transcript bound to the file, if any
 */
async function bindGemixVoiceTranscription(userId, syncedPath, chatId, msgTimestampMs) {
  if (!userId || !syncedPath) return null;
  let boundText = null;
  let claimedIndex = -1;

  await _mutateMeta(userId, (meta) => {
    const normalized = _normalizeHistoryFilename(syncedPath);
    const stored = normalized
      ? _findMetaEntry(meta, normalized).entry?.voiceTranscription?.text
      : null;
    if (typeof stored === 'string' && stored.trim()) {
      boundText = stored.trim();
      return false;
    }
    if (!chatId || !msgTimestampMs) return false;

    const match = _matchRecentVoiceText(chatId, msgTimestampMs);
    if (!match) return false;
    const target = _upsertMetaEntry(meta, normalized);
    if (!target.id || !target.normalized) return false;
    boundText = match.text;
    claimedIndex = match.index;
    meta[target.id] = {
      ...target.entry,
      voiceTranscription: {
        text: String(match.text).trim(),
        updatedAt: Date.now()
      }
    };
  }, () => {
    if (claimedIndex >= 0) _dropRecentVoiceEntry(claimedIndex);
  });
  return boundText;
}

/**
 * Save a file to the user's history folder. Handles deduplication by uniqueId.
 *
 * Files are stored as flat files under data/users/<id>/history/.
 *
 * @param {string} userId - The unique identifier for the user (e.g. from waJid or discord id)
 * @param {string} uniqueId - A unique ID for the attachment (e.g., Discord attachment ID or WA message ID)
 * @param {function} fetchBufferFn - Async function returning the file Buffer (called only if needed)
 * @param {string} originalName - Original file name
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<string>} The relative filename like 'filename.ext'
 */
async function syncFileToHistory(userId, uniqueId, fetchBufferFn, originalName, options = {}) {
  if (!userId || !uniqueId) return null;
  const signal = options.signal || null;
  signal?.throwIfAborted();

  return _withSyncLock(userId, async () => {
    signal?.throwIfAborted();
    const { historyDir, metaFile } = getUserHistoryPaths(userId);
    ensureDir(historyDir);

    // Read once and write once: the per-user lock is what makes that safe,
    // since no other sync for this user can interleave with this one.
    const meta = _loadMeta(metaFile, userId);

    // If uniqueId exists and the entry is actually on disk, reuse it
    if (meta[uniqueId]) {
      const existingName = _getEntryFilename(meta[uniqueId]);
      const existingPath = existingName ? path.join(historyDir, existingName) : null;
      if (existingPath && fs.existsSync(existingPath)) {
        try {
          const st = fs.statSync(existingPath);
          if (st.isFile() && st.size > 0) {
            const now = new Date();
            try { fs.utimesSync(existingPath, now, now); } catch { /* best-effort */ }
            return existingName;
          }
          log.warn(`History cache for ${uniqueId} is empty (${existingName}), re-downloading`);
          try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
        } catch { /* re-download below */ }
      }
      // Stale entry: empty/unreadable file above, or missing from disk entirely.
      delete meta[uniqueId];
      if (!_saveMeta(metaFile, meta, userId)) return null;
    }

    // We need the buffer now
    let buffer;
    try {
      buffer = await fetchBufferFn(signal);
      signal?.throwIfAborted();
      if (!buffer) return null;
    } catch (err) {
      log.error(`Failed to fetch buffer for ${originalName}: ${err.message}`);
      return null;
    }

    // Sanitize name: remove leading dots for security, keep alphanumerics
    const cleanName = sanitizeFilename(originalName || 'file').replace(/^\.+/, '') || 'file';

    const extMatch = cleanName.match(/\.([^.]+)$/);
    const ext = extMatch ? `.${extMatch[1]}` : '';
    const baseName = extMatch ? cleanName.slice(0, -ext.length) : cleanName;

    let finalName = cleanName;
    let counter = 1;
    const existingValues = new Set(Object.values(meta).map(_getEntryFilename).filter(Boolean));

    while (existingValues.has(finalName) || fs.existsSync(path.join(historyDir, finalName))) {
      finalName = `${baseName}(${counter})${ext}`;
      counter++;
      if (counter > 1000) {
        finalName = `${baseName}(${Date.now()}_${Math.floor(Math.random() * 10000)})${ext}`;
        break;
      }
    }

    // Publish bytes and metadata as one application transaction. A metadata
    // failure rolls the new file back so callers never receive an unindexed
    // filename that cannot be recovered by attachment ID.
    const filePath = path.join(historyDir, finalName);
    let wroteFile = false;
    try {
      signal?.throwIfAborted();
      fs.writeFileSync(filePath, buffer);
      wroteFile = true;
      signal?.throwIfAborted();
      meta[uniqueId] = { filename: finalName };
      if (!_saveMeta(metaFile, meta, userId)) {
        delete meta[uniqueId];
        try { fs.unlinkSync(filePath); } catch (rollbackErr) {
          log.warn(`Failed to roll back unindexed history file ${finalName}: ${rollbackErr.message}`);
        }
        return null;
      }
      return finalName;
    } catch (err) {
      delete meta[uniqueId];
      if (wroteFile) {
        try { fs.unlinkSync(filePath); } catch (rollbackErr) {
          log.warn(`Failed to roll back history file ${finalName}: ${rollbackErr.message}`);
        }
      }
      log.error(`Failed to save history file for user ${userId}: ${err.message}`);
      return null;
    }
  });
}

/**
 * Remove one conversation's complete durable history while holding the same
 * lock used by attachment and transcription writers.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} whether the store is absent after the operation
 */
async function deleteHistoryStore(userId) {
  if (!userId) return true;
  return _withSyncLock(userId, async () => {
    const { historyDir } = getUserHistoryPaths(userId);
    const userRoot = path.dirname(historyDir);
    try {
      fs.rmSync(userRoot, { recursive: true, force: true });
      return !fs.existsSync(userRoot);
    } catch (err) {
      log.warn(`Failed to delete history store for ${userId}: ${err.message}`);
      return false;
    }
  });
}

/**
 * Age sweep of one conversation's history store, on the shared hourly clock.
 *
 * Retention is 4h sliding from last use: a file's mtime is
 * refreshed when it is reused, so an active chat still lets an untouched file
 * go while a file the model keeps opening stays.
 *
 * Retention depends only on age and reuse, never on whether a file is still
 * referenced by the current 30-message window. This keeps files available for
 * later history rehydration until their own TTL expires.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] - retention window; defaults to the workspace TTL
 * @param {number} [opts.now]
 * @returns {Promise<{deletedCount: number, kept: number}>}
 */
async function sweepHistoryStore(userId, opts = {}) {
  if (!userId) return { deletedCount: 0, kept: 0 };
  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  if (!fs.existsSync(historyDir)) return { deletedCount: 0, kept: 0 };

  return _withSyncLock(userId, async () => {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : HISTORY_RETENTION_MS;

    let deletedCount = 0;
    let kept = 0;

    let entries;
    try { entries = fs.readdirSync(historyDir); }
    catch (err) {
      log.error(`sweepHistoryStore readdir failed for ${userId}: ${err.message}`);
      return { deletedCount: 0, kept: 0 };
    }

    for (const entry of entries) {
      const entryPath = path.join(historyDir, entry);
      let stat;
      try { stat = fs.statSync(entryPath); }
      catch { continue; }

      if ((now - stat.mtimeMs) <= maxAgeMs) { kept++; continue; }
      try {
        if (stat.isDirectory()) fs.rmSync(entryPath, { recursive: true, force: true });
        else fs.unlinkSync(entryPath);
        deletedCount++;
      } catch (err) {
        log.warn(`sweepHistoryStore remove failed for ${entry}: ${err.message}`);
      }
    }

    // Sync meta file: drop entries whose target file/dir no longer exists.
    if (deletedCount > 0 && fs.existsSync(metaFile)) {
      try {
        const meta = _loadMeta(metaFile, userId);
        let changed = false;
        for (const [id, entry] of Object.entries(meta)) {
          const name = _getEntryFilename(entry);
          if (!name) { delete meta[id]; changed = true; continue; }
          const diskName = name.endsWith('/') ? name.slice(0, -1) : name;
          if (!fs.existsSync(path.join(historyDir, diskName))) {
            delete meta[id];
            changed = true;
          }
        }
        if (changed) _saveMeta(metaFile, meta, userId);
      } catch (err) {
        log.warn(`sweepHistoryStore meta sync failed for ${userId}: ${err.message}`);
      }
    }

    if (deletedCount > 0) {
      log.info(`sweepHistoryStore user=${userId} removed=${deletedCount} kept=${kept}`);
    }
    return { deletedCount, kept };
  });
}

/** Sweep every conversation's history store in one pass. */
async function sweepAllHistoryStores(now = Date.now()) {
  let removed = 0;
  let dirs;
  try { dirs = fs.readdirSync(path.join(constants.DATA_DIR, 'users'), { withFileTypes: true }); }
  catch { return { removed: 0 }; }

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    removed += (await sweepHistoryStore(dirent.name, { now })).deletedCount;
  }
  return { removed };
}

export {
  getUserHistoryPaths,
  syncFileToHistory,
  deleteHistoryStore,
  bindGemixVoiceTranscription,
  getStoredHistoryVoiceTranscription,
  getStoredUserTranscription,
  storeUserTranscription,
  storeRecentVoiceText,
  forgetRecentVoiceText,
  sweepAllHistoryStores,
  sweepHistoryStore,
  HISTORY_RETENTION_MS
};
