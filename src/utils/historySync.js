// src/utils/historySync.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');
const { sanitizeFilename } = require('./text');

const log = createLogger('HistorySync');

// Discord-only age cap. WhatsApp deletes purely on chat-history reachability.
const DISCORD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
  const normalized = _normalizeHistoryFilename(historyFilename);
  if (!normalized) return false;

  const meta = _loadMeta(metaFile, userId);
  let targetKey = null;
  for (const [id, entry] of Object.entries(meta)) {
    if (_getEntryFilename(entry) === normalized) {
      targetKey = id;
      break;
    }
  }
  if (!targetKey) {
    targetKey = `file:${normalized}`;
  }

  const prev = meta[targetKey];
  const base = (prev && typeof prev === 'object') ? prev : { filename: normalized };
  meta[targetKey] = {
    ...base,
    filename: normalized,
    mediaDescription: {
      kind,
      text: String(text).trim(),
      updatedAt: Date.now(),
    },
  };
  return _saveMeta(metaFile, meta, userId);
}

/**
 * Save a file to the user's history folder. Handles deduplication by uniqueId.
 * @param {string} userId - The unique identifier for the user (e.g. from waJid or discord id)
 * @param {string} uniqueId - A unique ID for the attachment (e.g., Discord attachment ID or WA message ID)
 * @param {function} fetchBufferFn - Async function returning the file Buffer (called only if needed)
 * @param {string} originalName - Original file name
 * @returns {Promise<string>} The relative contextual path like 'history/filename.ext'
 */
async function syncFileToHistory(userId, uniqueId, fetchBufferFn, originalName) {
  if (!userId || !uniqueId) return null;

  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  ensureDir(historyDir);

  let meta = _loadMeta(metaFile, userId);

  // If uniqueId exists and the file is actually on disk, reuse it
  if (meta[uniqueId]) {
    const existingName = _getEntryFilename(meta[uniqueId]);
    const existingFile = existingName ? path.join(historyDir, existingName) : null;
    if (existingFile && fs.existsSync(existingFile)) {
      // Refresh timestamp to prevent premature deletion
      const now = Date.now();
      fs.utimesSync(existingFile, now, now);
      return `history/${existingName}`;
    }
    // File missing on disk, clear from meta and re-save
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

  // Find an available filename
  let finalName = cleanName;
  let counter = 1;
  const existingValues = new Set(Object.values(meta));

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
 * Removes file from disk and its hash from meta.
 */
function deleteFileFromHistory(userId, filename) {
  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  const filePath = path.join(historyDir, filename);

  // Load meta
  const meta = _loadMeta(metaFile, userId);

  // Find ID by filename
  let idToRemove = null;
  for (const [id, entry] of Object.entries(meta)) {
    if (_getEntryFilename(entry) === filename) {
      idToRemove = id;
      break;
    }
  }

  if (idToRemove) {
    delete meta[idToRemove];
    _saveMeta(metaFile, meta, userId);
  }

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      log.error(`Failed to delete history file ${filename}: ${err.message}`);
    }
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

  const referenced = referencedFilenames instanceof Set
    ? referencedFilenames
    : new Set(referencedFilenames || []);

  const now = Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : null;

  let deletedCount = 0;
  let ageDeletedCount = 0;
  let kept = 0;

  let files;
  try { files = fs.readdirSync(historyDir); }
  catch (err) {
    log.error(`pruneHistory readdir failed for ${userId}: ${err.message}`);
    return { deletedCount: 0, ageDeletedCount: 0, kept: 0 };
  }

  for (const file of files) {
    const filePath = path.join(historyDir, file);
    let stat;
    try { stat = fs.statSync(filePath); }
    catch { continue; }
    if (!stat.isFile()) continue;

    let shouldDelete = false;
    let ageDelete = false;
    if (!referenced.has(file)) {
      shouldDelete = true;
    } else if (maxAgeMs !== null && (now - stat.mtimeMs) > maxAgeMs) {
      shouldDelete = true;
      ageDelete = true;
    }

    if (shouldDelete) {
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
        if (ageDelete) ageDeletedCount++;
      } catch (err) {
        log.warn(`pruneHistory unlink failed for ${file}: ${err.message}`);
      }
    } else {
      kept++;
    }
  }

  // Sync meta file: drop entries whose target file no longer exists.
  if (deletedCount > 0 && fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      let changed = false;
      for (const [id, entry] of Object.entries(meta)) {
        const name = _getEntryFilename(entry);
        if (!name || !fs.existsSync(path.join(historyDir, name))) {
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
  const re = /\[Attachment(?:\s*\(expired\))?:\s*history\/([^\]\n\r]+)\]/g;
  const _scan = (text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim();
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
  const src = path.join(historyDir, historyFilename);
  if (!fs.existsSync(src)) {
    return { success: false, error: `history/${historyFilename} not found.` };
  }
  if (!fs.existsSync(destAbsDir)) {
    return { success: false, error: `Destination directory does not exist.` };
  }
  try {
    const finalName = _uniqueFilename(destAbsDir, historyFilename);
    fs.copyFileSync(src, path.join(destAbsDir, finalName));
    return { success: true, finalName };
  } catch (err) {
    log.error(`copyFromHistory failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  syncFileToHistory,
  copyFromHistory,
  getUserHistoryPaths,
  getStoredHistoryMediaDescription,
  storeHistoryMediaDescription,
  pruneHistory,
  collectReferencedHistoryFilenames,
  DISCORD_MAX_AGE_MS,
};
