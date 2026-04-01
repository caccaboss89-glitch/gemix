const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config/constants');

const CACHE_FILE = path.join(DATA_DIR, 'voiceTextCache.json');
const MAX_ENTRIES = 200;
const MATCH_TOLERANCE_MS = 120_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let entries = [];

function _load() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      entries = Array.isArray(raw) ? raw : [];
    }
  } catch { entries = []; }
}

function _save() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entries), 'utf-8');
  } catch {}
}

function _cleanup() {
  const cutoff = Date.now() - MAX_AGE_MS;
  const before = entries.length;
  entries = entries.filter(e => e.ts >= cutoff);
  if (entries.length < before) _save();
}

function storeVoiceText(chatId, text) {
  if (!chatId || !text) return;
  _cleanup();
  entries.push({ chatId, ts: Date.now(), text });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  _save();
}

function retrieveVoiceText(chatId, msgTimestampMs) {
  if (!chatId || !msgTimestampMs) return null;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].chatId !== chatId) continue;
    const diff = Math.abs(entries[i].ts - msgTimestampMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestDiff <= MATCH_TOLERANCE_MS) {
    return entries[bestIdx].text;
  }
  return null;
}

_load();

module.exports = { storeVoiceText, retrieveVoiceText };
