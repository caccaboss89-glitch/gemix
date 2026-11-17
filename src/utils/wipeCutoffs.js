// src/utils/wipeCutoffs.js
//
// When each WhatsApp chat was last emptied with the wipe command, stored as one
// JSON file keyed by the chat id:
//
//   data/wipeCutoffs.json   { "<chat id>": { wipedAt: <unix seconds> } }
//
// The history window (platforms/whatsapp/messageWindow.js) drops every message
// older than the chat's cutoff, so nothing from before a wipe reaches a later
// turn even when WhatsApp still holds a copy the chat clear could not remove.
// Seconds, because that is the clock a WhatsApp message timestamp runs on.
// The window drops the record once a full window holds only later messages,
// since nothing older can enter it again.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger } from './logger.js';

const log = createLogger('WipeCutoffs');

const CUTOFF_FILE = path.join(constants.DATA_DIR, 'wipeCutoffs.json');

// Serializes the read-modify-write cycle, like the other small JSON stores.
let _lock = Promise.resolve();

function _withLock(fn) {
  const prev = _lock;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  _lock = prev.catch(() => {}).then(() => gate);
  return prev.catch(() => {}).then(fn).finally(release);
}

function _read() {
  try {
    if (!fs.existsSync(CUTOFF_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CUTOFF_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    log.warn(`Failed to read ${CUTOFF_FILE}: ${err.message}`);
    return {};
  }
}

function _write(records) {
  const tempFile = CUTOFF_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tempFile, CUTOFF_FILE);
    return true;
  } catch (err) {
    log.warn(`Failed to write ${CUTOFF_FILE}: ${err.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    }
    return false;
  }
}

/**
 * Unix seconds of the chat's last wipe.
 * @param {string} chatId - whatsapp-web.js chat id (_serialized)
 * @returns {number|null} null when the chat has no cutoff
 */
function getWipeCutoff(chatId) {
  if (!chatId) return null;
  const wipedAt = _read()[chatId]?.wipedAt;
  return Number.isFinite(wipedAt) ? wipedAt : null;
}

/**
 * Record that the chat was wiped at `wipedAt`; a later wipe replaces it.
 * @param {string} chatId
 * @param {number} wipedAt - unix seconds
 * @returns {Promise<boolean>} false when the chat id or the write failed
 */
async function setWipeCutoff(chatId, wipedAt) {
  if (!chatId) return false;
  return _withLock(async () => {
    const records = _read();
    records[chatId] = { wipedAt };
    return _write(records);
  });
}

/**
 * Drop the chat's cutoff.
 * @param {string} chatId
 * @returns {Promise<boolean>} false only when the rewrite failed
 */
async function forgetWipeCutoff(chatId) {
  if (!chatId) return true;
  return _withLock(async () => {
    const records = _read();
    if (!(chatId in records)) return true;
    delete records[chatId];
    return _write(records);
  });
}

export { getWipeCutoff, setWipeCutoff, forgetWipeCutoff };
