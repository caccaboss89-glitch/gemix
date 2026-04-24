// src/utils/historySync.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');
const { sanitizeFilename } = require('./text');

const log = createLogger('HistorySync');

const GC_PROBABILITY = 0.05; // 5% chance to run GC on sync
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GC_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown per user
const lastGcTime = new Map();

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

  // Load metadata
  let meta = {};
  try {
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
  } catch (err) {
    log.warn(`Failed to read history_meta.json for user ${userId}: ${err.message}`);
  }

  // If uniqueId exists and the file is actually on disk, reuse it
  if (meta[uniqueId]) {
    const existingFile = path.join(historyDir, meta[uniqueId]);
    if (fs.existsSync(existingFile)) {
      // Refresh timestamp to prevent premature deletion
      const now = Date.now();
      fs.utimesSync(existingFile, now, now);
      return `history/${meta[uniqueId]}`;
    }
    // File missing on disk, clear from meta and re-save
    delete meta[uniqueId];
  }

  // Occasional Garbage Collection
  if (Math.random() < GC_PROBABILITY) {
    const lastGc = lastGcTime.get(userId) || 0;
    if (Date.now() - lastGc > GC_COOLDOWN_MS) {
      lastGcTime.set(userId, Date.now());
      setTimeout(() => cleanupOldHistory(userId).catch(() => {}), 0);
    }
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
    meta[uniqueId] = finalName;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
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
  let meta = {};
  try {
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    }
  } catch {}

  // Find ID by filename
  let idToRemove = null;
  for (const [id, name] of Object.entries(meta)) {
    if (name === filename) {
      idToRemove = id;
      break;
    }
  }

  if (idToRemove) {
    delete meta[idToRemove];
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {}
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
 * Garbage collection for history folder. Deletes files older than 30 days.
 */
async function cleanupOldHistory(userId) {
  const { historyDir, metaFile } = getUserHistoryPaths(userId);
  if (!fs.existsSync(historyDir)) return;

  const now = Date.now();
  let deletedCount = 0;

  try {
    const files = fs.readdirSync(historyDir);
    for (const file of files) {
      const filePath = path.join(historyDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > GC_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }

    if (deletedCount > 0 && fs.existsSync(metaFile)) {
      // Clean up meta file to remove deleted entries
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      let changed = false;
      for (const [id, name] of Object.entries(meta)) {
        if (!fs.existsSync(path.join(historyDir, name))) {
          delete meta[id];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
      }
      log.info(`Garbage Collection: Deleted ${deletedCount} old files for user ${userId}.`);
    }
  } catch (err) {
    log.error(`Garbage Collection failed for user ${userId}: ${err.message}`);
  }
}

module.exports = { syncFileToHistory };
