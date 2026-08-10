// src/utils/privacyConsent.js
//
// Registry of everyone who has already been shown the privacy notice, stored
// as one JSON file keyed by the sender's WhatsApp number:
//
//   data/privacyConsent.json   { "<digits>@c.us": { informedAt: "<ISO>" } }
//
// A person missing from it gets the notice instead of an AI turn on their next
// message (platforms/whatsapp/privacyGate.js), so the same number is informed
// once across every WhatsApp surface: dedicated DM, group, admin personal chat.
// The wipe command removes the entry, which is why refusing the terms brings
// the notice back if the person ever writes again.
//
// Discord is deliberately out of scope: nothing there reads or writes this file.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { createLogger  } from './logger.js';
import { getRomeISO  } from './time.js';

const log = createLogger('PrivacyConsent');

const CONSENT_FILE = path.join(constants.DATA_DIR, 'privacyConsent.json');

// Serializes the read-modify-write cycle, like the other small JSON stores.
let _lock = Promise.resolve();

function _withLock(fn) {
  const prev = _lock;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  _lock = prev.catch(() => {}).then(() => gate);
  return prev.catch(() => {}).then(fn).finally(release);
}

/**
 * Canonical registry key for a WhatsApp sender: the bare number as `<digits>@c.us`,
 * so a device-suffixed or @lid-shaped JID maps to the same person.
 * @param {string} waJid
 * @returns {string|null} null when no digits can be extracted
 */
function consentKey(waJid) {
  const digits = String(waJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits ? `${digits}@c.us` : null;
}

function _read() {
  try {
    if (!fs.existsSync(CONSENT_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    log.warn(`Failed to read ${CONSENT_FILE}: ${err.message}`);
    return {};
  }
}

function _write(records) {
  const tempFile = CONSENT_FILE + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(records, null, 2), 'utf-8');
    fs.renameSync(tempFile, CONSENT_FILE);
    return true;
  } catch (err) {
    log.warn(`Failed to write ${CONSENT_FILE}: ${err.message}`);
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    }
    return false;
  }
}

/**
 * True when this number has already received the notice. Unresolvable JIDs read
 * as informed: a message we cannot attribute must not trigger a second notice
 * on every turn.
 * @param {string} waJid
 * @returns {boolean}
 */
function hasBeenInformed(waJid) {
  const key = consentKey(waJid);
  if (!key) return true;
  return Boolean(_read()[key]);
}

/**
 * Record that the notice was delivered to this number.
 * @param {string} waJid
 * @returns {Promise<boolean>} false when the JID or the write failed
 */
async function markInformed(waJid) {
  const key = consentKey(waJid);
  if (!key) return false;
  return _withLock(async () => {
    const records = _read();
    records[key] = { informedAt: getRomeISO() };
    return _write(records);
  });
}

/**
 * Drop this number from the registry (part of the data wipe).
 * @param {string} waJid
 * @returns {Promise<boolean>} false only when the rewrite failed
 */
async function forgetUser(waJid) {
  const key = consentKey(waJid);
  if (!key) return true;
  return _withLock(async () => {
    const records = _read();
    if (!(key in records)) return true;
    delete records[key];
    return _write(records);
  });
}

export { hasBeenInformed, markInformed, forgetUser
};
