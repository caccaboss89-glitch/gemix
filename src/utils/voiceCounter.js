// src/utils/voiceCounter.js
//
// Persistent per-chat voice-message counter. Used to enforce the "max 3
// consecutive voice replies" UX rule: the AI is forbidden from sending a
// 4th voice in the same chat without a text turn in between.
//
// Storage:
//   - Per-user file at  data/users/<storageId>/voice_counts.json.
//   - Shape: { "<chatKey>": <integer> }
//   - chatKey is whatever caller passes (see _getVoiceLimitChatKey in
//     tools/index.js - typically chatId / groupId / waJid).
//
// Concurrency: in-memory mutex per storageId so the read-modify-write
// cycle is atomic across overlapping tool calls.
//
// History: this used to live inside the per-user `.state.json` together
// with the legacy project state (current_project, locks, crash flags).
// The cleanup that retired the project sub-system kept the voice limiter
// intact and moved it here so it stops carrying that baggage.

const fs = require('fs');
const path = require('path');
const { resolveStorageId, getUserRoot, ensureUserSkeleton } = require('./userPaths');
const { createLogger } = require('./logger');

const log = createLogger('VoiceCounter');

const FILENAME = 'voice_counts.json';

const _locks = new Map();

async function _withLock(userCtx, fn) {
  const id = resolveStorageId(userCtx) || '__global__';
  while (_locks.get(id)) await _locks.get(id);
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  _locks.set(id, promise);
  try { return await fn(); }
  finally {
    _locks.delete(id);
    resolve();
  }
}

function _file(userCtx) {
  const root = getUserRoot(userCtx);
  if (!root) return null;
  return path.join(root, FILENAME);
}

function _read(userCtx) {
  const f = _file(userCtx);
  if (!f || !fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')) || {}; }
  catch (err) {
    log.warn(`Corrupted voice_counts.json, resetting: ${err.message}`);
    return {};
  }
}

function _write(userCtx, data) {
  const f = _file(userCtx);
  if (!f) return false;
  const root = getUserRoot(userCtx);
  if (!fs.existsSync(root)) ensureUserSkeleton(userCtx);
  const tmp = f + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, f);
    return true;
  } catch (err) {
    log.warn(`Failed to persist voice_counts: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Get current consecutive voice count for a chatKey.
 * @param {object} userCtx
 * @param {string} chatKey
 * @returns {Promise<number>}
 */
function getVoiceCount(userCtx, chatKey) {
  return _withLock(userCtx, () => {
    const data = _read(userCtx);
    return Number(data[chatKey]) || 0;
  });
}

/**
 * Increment the consecutive voice counter for a chatKey.
 * @param {object} userCtx
 * @param {string} chatKey
 * @returns {Promise<number>} new count
 */
function incrementVoiceCount(userCtx, chatKey) {
  return _withLock(userCtx, () => {
    const data = _read(userCtx);
    data[chatKey] = (Number(data[chatKey]) || 0) + 1;
    _write(userCtx, data);
    return data[chatKey];
  });
}

/**
 * Reset the consecutive voice counter for a chatKey (called after a text reply).
 * @param {object} userCtx
 * @param {string} chatKey
 * @returns {Promise<number>} 0
 */
function resetVoiceCount(userCtx, chatKey) {
  return _withLock(userCtx, () => {
    const data = _read(userCtx);
    if (data[chatKey]) {
      delete data[chatKey];
      _write(userCtx, data);
    }
    return 0;
  });
}

module.exports = {
  getVoiceCount,
  incrementVoiceCount,
  resetVoiceCount,
};
