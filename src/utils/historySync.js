// src/utils/historySync.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR, MAX_DOC_PAGES } = require('../config/constants');
const { createLogger } = require('./logger');
const { extractAttachmentTagPaths, extractTextFromPdfBuffer } = require('./media');
const { sanitizeFilename } = require('./text');

const log = createLogger('HistorySync');

// Discord-only age cap. WhatsApp deletes purely on chat-history reachability.
const DISCORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RECENT_VOICE_CACHE_FILE = path.join(DATA_DIR, 'voiceTextCache.json');
const RECENT_VOICE_MAX_ENTRIES = 200;
const RECENT_VOICE_MATCH_TOLERANCE_MS = 20_000;
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
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log.warn(`Failed to write history_meta.json for user ${userId}: ${err.message}`);
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
    if (fs.existsSync(RECENT_VOICE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RECENT_VOICE_CACHE_FILE, 'utf-8'));
      recentVoiceEntries = Array.isArray(raw) ? raw : [];
    }
  } catch {
    recentVoiceEntries = [];
  }
}

function _saveRecentVoiceEntries() {
  try {
    fs.writeFileSync(RECENT_VOICE_CACHE_FILE, JSON.stringify(recentVoiceEntries), 'utf-8');
  } catch {}
}

function _cleanupRecentVoiceEntries() {
  const cutoff = Date.now() - RECENT_VOICE_MAX_AGE_MS;
  const before = recentVoiceEntries.length;
  recentVoiceEntries = recentVoiceEntries.filter(e => e && e.ts >= cutoff);
  if (recentVoiceEntries.length < before) _saveRecentVoiceEntries();
}

function storeRecentVoiceText(chatId, text) {
  if (!chatId || !text) return;
  _cleanupRecentVoiceEntries();
  recentVoiceEntries.push({ chatId, ts: Date.now(), text });
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

function getStoredHistoryMediaDescription(userId, historyFilename, expectedKind = null) {
  if (!userId || !historyFilename) return null;
  const { metaFile } = getUserHistoryPaths(userId);
  const normalized = _normalizeHistoryFilename(historyFilename);
  if (!normalized) return null;

  const meta = _loadMeta(metaFile, userId);
  for (const entry of Object.values(meta)) {
    if (_getEntryFilename(entry) !== normalized) continue;
    if (!entry || typeof entry !== 'object' || !entry.mediaDescription) return null;
    const desc = entry.mediaDescription;
    if (expectedKind && desc.kind && desc.kind !== expectedKind) return null;
    if (typeof desc.text !== 'string' || !desc.text.trim()) return null;
    return desc.text.trim();
  }
  return null;
}

function storeHistoryMediaDescription(userId, historyFilename, kind, text) {
  if (!userId || !historyFilename || !kind || !text) return false;
  const { metaFile } = getUserHistoryPaths(userId);
  const meta = _loadMeta(metaFile, userId);
  const target = _upsertMetaEntry(meta, historyFilename);
  if (!target.id || !target.normalized) return false;
  meta[target.id] = {
    ...target.entry,
    mediaDescription: {
      kind,
      text: String(text).trim(),
      updatedAt: Date.now(),
    },
  };
  return _saveMeta(metaFile, meta, userId);
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
 * Save a file to the user's history folder. Handles deduplication by uniqueId.
 *
 * **PDFs** are stored as directories:
 *   `history/<name>/` containing `transcription.md` and an `assets/` subfolder
 *   with extracted images. The returned path still looks like `history/<name>/`.
 *
 * All other file types are stored as flat files (unchanged behaviour).
 *
 * @param {string} userId - The unique identifier for the user (e.g. from waJid or discord id)
 * @param {string} uniqueId - A unique ID for the attachment (e.g., Discord attachment ID or WA message ID)
 * @param {function} fetchBufferFn - Async function returning the file Buffer (called only if needed)
 * @param {string} originalName - Original file name
 * @returns {Promise<string>} The relative contextual path like 'history/filename.ext' or 'history/name/'
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
      return `history/${existingName}`;
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
  let cleanName = sanitizeFilename(originalName || 'file');
  cleanName = cleanName.replace(/^\.+/, ''); // Strip leading dots
  if (!cleanName) cleanName = 'file';

  const extMatch = cleanName.match(/\.([^.]+)$/);
  const ext = extMatch ? `.${extMatch[1]}` : '';
  const baseName = extMatch ? cleanName.slice(0, -ext.length) : cleanName;
  const isPdf = ext.toLowerCase() === '.pdf';

  // ── PDF directory-based storage ──
  if (isPdf) {
    // For PDFs we store a directory named after the base (without .pdf)
    let dirName = baseName;
    let counter = 1;
    const existingValues = new Set(Object.values(meta).map(_getEntryFilename).filter(Boolean));
    while (existingValues.has(dirName + '/') || fs.existsSync(path.join(historyDir, dirName))) {
      dirName = `${baseName}(${counter})`;
      counter++;
    }
    const pdfDir = path.join(historyDir, dirName);
    try {
      fs.mkdirSync(pdfDir, { recursive: true });

      // Parse with Heavy/Hybrid AI mode, persisting images into pdfDir/assets/
      const info = await extractTextFromPdfBuffer(buffer, { persistDir: pdfDir });
      let transcription = '';
      if (info.success && info.text) {
        if (info.pages > MAX_DOC_PAGES) {
          transcription = `[Document too long to process: ${info.pages} pages (max ${MAX_DOC_PAGES})]`;
        } else {
          transcription = info.text;
        }
      } else {
        transcription = `[PDF transcription failed: ${info.error || 'unknown error'}]`;
      }

      fs.writeFileSync(path.join(pdfDir, 'transcription.md'), transcription, 'utf-8');

      const finalName = dirName + '/';
      meta[uniqueId] = { filename: finalName, type: 'pdf-dir' };
      _saveMeta(metaFile, meta, userId);
      return `history/${finalName}`;
    } catch (err) {
      log.error(`Failed to save PDF history dir for user ${userId}: ${err.message}`);
      // Clean up partial directory
      try { fs.rmSync(pdfDir, { recursive: true, force: true }); } catch { }
      return null;
    }
  }

  // ── Standard flat-file storage (non-PDF) ──
  let finalName = cleanName;
  let counter = 1;
  const existingValues = new Set(Object.values(meta).map(_getEntryFilename).filter(Boolean));

  while (existingValues.has(finalName) || fs.existsSync(path.join(historyDir, finalName))) {
    finalName = `${baseName}(${counter})${ext}`;
    counter++;
  }

  // Write file and update meta
  const filePath = path.join(historyDir, finalName);
  try {
    fs.writeFileSync(filePath, buffer);
    meta[uniqueId] = { filename: finalName };
    _saveMeta(metaFile, meta, userId);
    return `history/${finalName}`;
  } catch (err) {
    log.error(`Failed to save history file for user ${userId}: ${err.message}`);
    return null;
  }
}

/**
 * Deterministic prune. Called by the handler at the start of EVERY user
 * message, before the AI call. Removes from `history/<userId>/` every file
 * that is no longer reachable from the current chat history (i.e. its
 * filename does not appear in the set of `[Attachment: history/<name>]`
 * tags the AI is about to see).
 *
 * Optionally also removes files older than `maxAgeMs` (used on Discord to
 * keep at most 30 days of attachments even if they are still referenced
 * via reply quotes).
 *
 * @param {string} userId
 * @param {Set<string>|Iterable<string>} referencedFilenames - bare filenames present in the chat buffer (no "history/" prefix)
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] - extra age cap (Discord uses 30d; WhatsApp omits)
 * @returns {{deletedCount: number, ageDeletedCount: number, kept: number}}
 */
function pruneHistory(userId, referencedFilenames, opts = {}) {
  if (!userId) return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };
  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  if (!fs.existsSync(historyDir)) return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };

  // Build referenced set. For PDF dirs stored as "name/", the attachment tag
  // path is "history/name/" so the bare filename reaching us is "name/".
  const referenced = referencedFilenames instanceof Set
    ? referencedFilenames
    : new Set(referencedFilenames || []);

  const now = Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : null;

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
    if (!referenced.has(refKey) && !referenced.has(entry)) {
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
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
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
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
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
 * Extract the bare filenames from every `[Attachment: history/<file>]` tag
 * found in the provided chat history. Used by the handler to feed pruneHistory.
 *
 * @param {Array<{content: any}>} historyMsgs
 * @param {any} [currentContent] - current incoming message content (already in scope before AI call)
 * @returns {Set<string>}
 */
function collectReferencedHistoryFilenames(historyMsgs, currentContent) {
  const out = new Set();
  const _scan = (text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    for (const taggedPath of extractAttachmentTagPaths(text)) {
      if (!taggedPath.startsWith('history/')) continue;
      const name = taggedPath.slice('history/'.length).trim();
      if (name) out.add(name);
    }
  };
  const _scanContent = (c) => {
    if (!c) return;
    if (typeof c === 'string') return _scan(c);
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part && typeof part === 'object' && typeof part.text === 'string') _scan(part.text);
      }
    }
  };
  if (Array.isArray(historyMsgs)) {
    for (const m of historyMsgs) _scanContent(m && m.content);
  }
  _scanContent(currentContent);
  return out;
}

/**
 * Resolve a unique filename inside a destination directory, appending (n) to avoid collisions.
 */
function _uniqueFilename(destDir, baseName) {
  let cleaned = sanitizeFilename(baseName || 'file').replace(/^\.+/, '') || 'file';
  if (!fs.existsSync(path.join(destDir, cleaned))) return cleaned;
  const extMatch = cleaned.match(/\.([^.]+)$/);
  const ext = extMatch ? `.${extMatch[1]}` : '';
  const stem = extMatch ? cleaned.slice(0, -ext.length) : cleaned;
  let i = 1;
  while (fs.existsSync(path.join(destDir, `${stem}(${i})${ext}`))) i++;
  return `${stem}(${i})${ext}`;
}

/**
 * Copy a file from history/ to a destination directory inside the same user folder.
 * Never moves — the source must stay intact so the chat history keeps pointing to it.
 *
 * @param {string} userId - storageId used for the user folder
 * @param {string} historyFilename - filename as stored inside history/ (no "history/" prefix)
 * @param {string} destAbsDir - absolute path to the destination directory (must already exist)
 * @returns {{success: boolean, finalName?: string, error?: string}}
 */
function copyFromHistory(userId, historyFilename, destAbsDir) {
  const { historyDir } = getUserHistoryPaths(userId);
  // Strip trailing slash for disk lookup
  const diskName = historyFilename.endsWith('/') ? historyFilename.slice(0, -1) : historyFilename;
  const src = path.join(historyDir, diskName);
  if (!fs.existsSync(src)) {
    return { success: false, error: `history/${historyFilename} not found.` };
  }
  if (!fs.existsSync(destAbsDir)) {
    return { success: false, error: `Destination directory does not exist.` };
  }
  try {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      // PDF directory — copy the entire tree
      const finalName = _uniqueFilename(destAbsDir, diskName);
      const destPath = path.join(destAbsDir, finalName);
      fs.cpSync(src, destPath, { recursive: true });
      return { success: true, finalName };
    }
    const finalName = _uniqueFilename(destAbsDir, historyFilename);
    fs.copyFileSync(src, path.join(destAbsDir, finalName));
    return { success: true, finalName };
  } catch (err) {
    log.error(`copyFromHistory failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

_loadRecentVoiceEntries();

module.exports = {
  syncFileToHistory,
  copyFromHistory,
  getUserHistoryPaths,
  getStoredHistoryMediaDescription,
  getStoredHistoryVoiceTranscription,
  retrieveRecentVoiceText,
  storeHistoryMediaDescription,
  storeHistoryVoiceTranscription,
  storeRecentVoiceText,
  pruneHistory,
  collectReferencedHistoryFilenames,
  DISCORD_MAX_AGE_MS,
};
