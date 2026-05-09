// src/utils/systemState.js
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');
const { createLogger } = require('./logger');

const log = createLogger('SystemState');
const STATE_FILE = path.join(DATA_DIR, 'systemState.json');

const { getRomeISO } = require('./time');

// In-memory lock to ensure atomic read-modify-write
let _lockPromise = Promise.resolve();

/**
 * Executes a function with a global lock on the system state.
 */
async function _withLock(fn) {
  const nextLock = _lockPromise.then(() => fn());
  _lockPromise = nextLock.catch(() => {}); // Prevent chain break on error
  return nextLock;
}

function _readRaw() {
  if (!fs.existsSync(STATE_FILE)) return {};
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  if (!raw.trim()) return {}; // Empty file
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error(`CRITICAL: systemState.json is corrupted! ${err.message}`);
    // Throwing ensures update() doesn't proceed to overwrite it with empty state
    throw new Error(`System state corruption: ${err.message}`);
  }
}

function _writeRaw(state) {
  const tempFile = STATE_FILE + '.tmp';
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    
    // Write to a temporary file first
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    
    // Rename to the actual file (atomic operation on most filesystems)
    fs.renameSync(tempFile, STATE_FILE);
    
    return true;
  } catch (err) {
    log.error(`Failed to write systemState.json: ${err.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
    return false;
  }
}

/**
 * Get state for a specific module.
 * @param {string} moduleName
 * @returns {any}
 */
function get(moduleName) {
  const state = _readRaw();
  return state[moduleName] || null;
}

/**
 * Update state for a specific module.
 * @param {string} moduleName
 * @param {object|function} update - New state object or function receiving current module state
 */
async function update(moduleName, update) {
  return _withLock(async () => {
    const state = _readRaw();
    const current = state[moduleName] || {};
    
    let next;
    if (typeof update === 'function') {
      next = await update(current);
    } else {
      next = { ...current, ...update };
    }
    
    state[moduleName] = next;
    return _writeRaw(state);
  });
}

/**
 * Specialized helper for daily tool tracking.
 * Checks if a tool can be used by a user today (limit: 1 user per day globally).
 * @param {string} toolId
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
async function checkDailyToolUsage(toolId, userId) {
  let result = { allowed: false };
  
  await _withLock(async () => {
    const state = _readRaw();
    if (!state.toolTracking) state.toolTracking = {};
    if (!state.toolTracking[toolId]) state.toolTracking[toolId] = { lastUser: null, lastDate: null };
    
    const tracking = state.toolTracking[toolId];
    const today = getRomeISO().split('T')[0]; // YYYY-MM-DD (Rome time)
    
    if (tracking.lastDate === today) {
      if (tracking.lastUser === userId) {
        result = { allowed: true }; // Same user can reuse it today
      } else {
        result = { allowed: false, reason: 'Il tool è già stato usato da un altro utente oggi.' };
      }
    } else {
      // New day, allow and record
      tracking.lastDate = today;
      tracking.lastUser = userId;
      state.toolTracking[toolId] = tracking;
      _writeRaw(state);
      result = { allowed: true };
    }
  });
  
  return result;
}

module.exports = {
  get,
  update,
  checkDailyToolUsage
};
