// src/utils/historySync.js
//
// Handles persistent storage of user/group chat history files, deterministic
// pruning of unreferenced attachments, and metadata for GemiX voice
// transcriptions. Also manages the short-lived voice text cache written when
// send_voice_message runs (matched to bot voice files in history).

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');
const { sanitizeFilename } = require('./text');
const { extractAttachmentTagPaths } = require('./media');

const FILE_CONTENT_PATH_RE = /<FileContent\s+path="([^"]+)"/gi;

const log = createLogger('HistorySync');

// Age cap on on-disk history attachments when reference-based prune is skipped
// (history fetch timeout/incomplete). Files older than this TTL are removed;
// the next successful history rebuild re-syncs media from the last MAX_HISTORY messages.
const DISCORD_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
const GEMIX_VOICE_TEXT_CACHE_FILE = path.join(DATA_DIR, 'gemixVoiceTextCache.json');
const RECENT_VOICE_MAX_ENTRIES = 200;
/** Match cache entry to history message time (voice sent vs history rebuild delay). */
const RECENT_VOICE_MATCH_TOLERANCE_MS = 120_000;
const RECENT_VOICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let recentVoiceEntries = [];

/**
 * Get the history directory and meta file for a user.
 * @param {string} userId - Unique identifier for the user's folder
 * @returns {object} { historyDir, metaFile }
 */
function getUserHistoryPaths(userId) {
  const userDir = path.join(DATA_DIR, 'users', userId);
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
  try {
    const legacyPath = path.join(DATA_DIR, 'voiceTextCache.json');
    if (!fs.existsSync(GEMIX_VOICE_TEXT_CACHE_FILE) && fs.existsSync(legacyPath)) {
      try { fs.renameSync(legacyPath, GEMIX_VOICE_TEXT_CACHE_FILE); } catch { /* use legacy read below */ }
    }
    const readPath = fs.existsSync(GEMIX_VOICE_TEXT_CACHE_FILE)
      ? GEMIX_VOICE_TEXT_CACHE_FILE
      : (fs.existsSync(legacyPath) ? legacyPath : null);
    if (readPath) {
      const raw = JSON.parse(fs.readFileSync(readPath, 'utf-8'));
      recentVoiceEntries = Array.isArray(raw) ? raw : [];
    }
  } catch {
    recentVoiceEntries = [];
  }
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

function retrieveRecentVoiceText(chatId, msgTimestampMs) {
  if (!chatId || !msgTimestampMs) return null;
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
  if (bestIdx >= 0 && bestDiff <= RECENT_VOICE_MATCH_TOLERANCE_MS) {
    return recentVoiceEntries[bestIdx].text;
  }
  return null;
}

function _findMetaEntry(meta, historyFilename) {
  for (const [id, entry] of Object.entries(meta)) {
    if (_getEntryFilename(entry) === historyFilename) {
      return { id, entry };
    }
  }
  return { id: null, entry: null };
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

function getStoredHistoryVoiceTranscription(userId, historyFilename) {
  if (!userId || !historyFilename) return null;
  const { metaFile } = getUserHistoryPaths(userId);
  const normalized = _normalizeHistoryFilename(historyFilename);
  if (!normalized) return null;

  const meta = _loadMeta(metaFile, userId);
  for (const entry of Object.values(meta)) {
    if (_getEntryFilename(entry) !== normalized) continue;
    if (!entry || typeof entry !== 'object' || !entry.voiceTranscription) return null;
    const voice = entry.voiceTranscription;
    if (typeof voice.text !== 'string' || !voice.text.trim()) return null;
    return voice.text.trim();
  }
  return null;
}

function storeHistoryVoiceTranscription(userId, historyFilename, text) {
  if (!userId || !historyFilename || !text) return false;
  const { metaFile } = getUserHistoryPaths(userId);
  const meta = _loadMeta(metaFile, userId);
  const target = _upsertMetaEntry(meta, historyFilename);
  if (!target.id || !target.normalized) return false;
  meta[target.id] = {
    ...target.entry,
    voiceTranscription: {
      text: String(text).trim(),
      updatedAt: Date.now(),
    },
  };
  return _saveMeta(metaFile, meta, userId);
}

/**
 * Transcription for GemiX (bot) voice attachments in chat history only.
 * Reads history_meta first; otherwise matches the short cache written when
 * send_voice_message runs, then persists into history_meta.
 * Never used for end-user voice notes.
 */
function resolveGemixVoiceTranscription(userId, syncedPath, chatId, msgTimestampMs) {
  if (!userId || !syncedPath) return null;
  const stored = getStoredHistoryVoiceTranscription(userId, syncedPath);
  if (stored) return stored;
  if (!chatId || !msgTimestampMs) return null;
  const recent = retrieveRecentVoiceText(chatId, msgTimestampMs);
  if (!recent) return null;
  storeHistoryVoiceTranscription(userId, syncedPath, recent);
  return recent;
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
 * @returns {Promise<string>} The relative filename like 'filename.ext'
 */
async function syncFileToHistory(userId, uniqueId, fetchBufferFn, originalName) {
  if (!userId || !uniqueId) return null;

  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  ensureDir(historyDir);

  let meta = _loadMeta(metaFile, userId);

  // If uniqueId exists and the entry is actually on disk, reuse it
  if (meta[uniqueId]) {
    const existingName = _getEntryFilename(meta[uniqueId]);
    const existingPath = existingName ? path.join(historyDir, existingName) : null;
    if (existingPath && fs.existsSync(existingPath)) {
      // Refresh timestamp to prevent premature deletion
      const now = new Date();
      try {
        // Works for both files and directories
        fs.utimesSync(existingPath, now, now);
      } catch { /* best-effort */ }
      return existingName;
    }
    // Entry missing on disk, clear from meta and re-save
    delete meta[uniqueId];
    _saveMeta(metaFile, meta, userId);
  }

  // We need the buffer now
  let buffer;
  try {
    buffer = await fetchBufferFn();
    if (!buffer) return null;
  } catch (err) {
    log.error(`Failed to fetch buffer for ${originalName}: ${err.message}`);
    return null;
  }

  // Sanitize name: remove leading dots for security, keep alphanumerics
  let cleanName = sanitizeFilename(originalName || 'file').replace(/^\.+/, '') || 'file';

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

  // Write file and update meta
  const filePath = path.join(historyDir, finalName);
  try {
    fs.writeFileSync(filePath, buffer);
    const freshMeta = _loadMeta(metaFile, userId);
    freshMeta[uniqueId] = { filename: finalName };
    _saveMeta(metaFile, freshMeta, userId);
    return finalName;
  } catch (err) {
    log.error(`Failed to save history file for user ${userId}: ${err.message}`);
    return null;
  }
}

/**
 * Deterministic prune. Called by the handler at the start of EVERY user
 * message, before the AI call. Removes from chat history every file
 * that is no longer reachable from the current chat history (i.e. its
 * filename does not appear in the set of `[Attachment: <name>]`
 * tags the AI is about to see).
 *
 * Optionally also removes files older than `maxAgeMs` (Discord: 4h; WA: none).
 * Discord re-fetches missing files from the thread when history is rebuilt.
 *
 * @param {string} userId
 * @param {Set<string>|Iterable<string>} referencedFilenames - bare filenames present in the chat buffer (no "history/" prefix)
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] - extra age cap (Discord: 4h via DISCORD_MAX_AGE_MS; WA: none)
 * @param {boolean} [opts.ageOnly] - when true, delete only files older than maxAgeMs (safe if history load failed)
 * @returns {{deletedCount: number, ageDeletedCount: number, kept: number}}
 */
function pruneHistory(userId, referencedFilenames, opts = {}) {
  if (!userId) return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };
  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  if (!fs.existsSync(historyDir)) return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };

  // Build referenced set. For PDF dirs stored as "name/", the attachment tag
  // path is "name/" so the bare filename reaching us is "name/".
  const referenced = referencedFilenames instanceof Set
    ? referencedFilenames
    : new Set(referencedFilenames || []);

  const now = Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : null;
  const ageOnly = Boolean(opts.ageOnly);

  let deletedCount = 0;
  let ageDeletedCount = 0;
  let kept = 0;

  let entries;
  try { entries = fs.readdirSync(historyDir); }
  catch (err) {
    log.error(`pruneHistory readdir failed for ${userId}: ${err.message}`);
    return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };
  }

  for (const entry of entries) {
    const entryPath = path.join(historyDir, entry);
    let stat;
    try { stat = fs.statSync(entryPath); }
    catch { continue; }

    // For directories (PDF dirs), the reference key includes trailing slash
    const refKey = stat.isDirectory() ? entry + '/' : entry;

    let shouldDelete = false;
    let ageDelete = false;
    if (ageOnly) {
      if (maxAgeMs !== null && (now - stat.mtimeMs) > maxAgeMs) {
        shouldDelete = true;
        ageDelete = true;
      }
    } else if (!referenced.has(refKey) && !referenced.has(entry)) {
      shouldDelete = true;
    } else if (maxAgeMs !== null && (now - stat.mtimeMs) > maxAgeMs) {
      shouldDelete = true;
      ageDelete = true;
    }

    if (shouldDelete) {
      try {
        if (stat.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(entryPath);
        }
        deletedCount++;
        if (ageDelete) ageDeletedCount++;
      } catch (err) {
        log.warn(`pruneHistory remove failed for ${entry}: ${err.message}`);
      }
    } else {
      kept++;
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
        // Strip trailing slash for fs.existsSync check
        const diskName = name.endsWith('/') ? name.slice(0, -1) : name;
        if (!fs.existsSync(path.join(historyDir, diskName))) {
          delete meta[id];
          changed = true;
        }
      }
      if (changed) {
        _saveMeta(metaFile, meta, userId);
      }
    } catch (err) {
      log.warn(`pruneHistory meta sync failed for ${userId}: ${err.message}`);
    }
  }

  if (deletedCount > 0) {
    log.info(`pruneHistory user=${userId} removed=${deletedCount} (age-based=${ageDeletedCount}) kept=${kept}`);
  }
  return { deletedCount, ageDeletedCount, kept };
}

/**
 * Collect on-disk history filenames still referenced by the chat buffer
 * (attachment tags, inline FileContent paths, multimodal _historyPath hints).
 *
 * @param {Array<{content: any}>} historyMsgs
 * @param {any} [currentContent] - current turn user content
 * @returns {Set<string>}
 */
function collectReferencedHistoryFilenames(historyMsgs, currentContent) {
  const out = new Set();
  const _addName = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    let name = raw.trim().replace(/\\/g, '/');
    if (name.startsWith('history/')) name = name.slice('history/'.length).trim();
    if (name) out.add(name);
  };
  const _scanText = (text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    for (const taggedPath of extractAttachmentTagPaths(text)) _addName(taggedPath);
    let m;
    FILE_CONTENT_PATH_RE.lastIndex = 0;
    while ((m = FILE_CONTENT_PATH_RE.exec(text)) !== null) {
      _addName(m[1]);
    }
  };
  const _scanPart = (part) => {
    if (!part || typeof part !== 'object') return;
    if (typeof part.text === 'string') _scanText(part.text);
    if (typeof part._historyPath === 'string') _addName(part._historyPath);
  };
  const _scanContent = (c) => {
    if (!c) return;
    if (typeof c === 'string') return _scanText(c);
    if (Array.isArray(c)) {
      for (const part of c) _scanPart(part);
    }
  };
  if (Array.isArray(historyMsgs)) {
    for (const msg of historyMsgs) _scanContent(msg && msg.content);
  }
  _scanContent(currentContent);
  return out;
}

_loadRecentVoiceEntries();

module.exports = {
  syncFileToHistory,
  getUserHistoryPaths,
  resolveGemixVoiceTranscription,
  storeHistoryVoiceTranscription,
  storeRecentVoiceText,
  pruneHistory,
  collectReferencedHistoryFilenames,
  DISCORD_MAX_AGE_MS,
};
