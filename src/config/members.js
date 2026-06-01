// src/config/members.js
//
// Active member registry.
//
// The member list is stored in src/data/members.json (gitignored).
// This module loads the active members at startup.
//
// If the members file is missing or invalid, the loader returns an empty list.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./constants');
const { GEMIX_MEMBERS_FILE } = require('./env');
const { createLogger } = require('../utils/logger');

const log = createLogger('Members');

// Fallback members list.
// Empty because active members are loaded from src/data/members.json.
// Supports fallback in the loading logic.
const _LEGACY_HARDCODED_MEMBERS = [];

function _loadMembers() {
  const customPath = GEMIX_MEMBERS_FILE && GEMIX_MEMBERS_FILE.trim();
  const candidate = customPath
    ? path.resolve(customPath)
    : path.join(DATA_DIR, 'members.json');

  try {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed) && parsed.length > 0) {
        log.info(`Loaded ${parsed.length} active member(s) from ${candidate}`);
        return parsed;
      }

      log.warn(`Members file at ${candidate} exists but is empty or invalid. No members loaded.`);
      return [];
    }
  } catch (err) {
    log.error(`Failed to read members file at ${candidate}: ${err.message}`);
  }

  // No valid members file found
  if (_LEGACY_HARDCODED_MEMBERS.length > 0) {
    log.warn('Falling back to legacy hardcoded members list (not recommended for production).');
    return _LEGACY_HARDCODED_MEMBERS;
  }

  log.error(
    `No members file found at ${candidate}.\n` +
    `The active members list must be provided in a JSON file (see src/data/members.json).`
  );

  return [];
}

const ACTIVE_MEMBERS = _loadMembers();

/**
 * Find a member by WhatsApp JID.
 * @param {string} jid - WhatsApp JID (e.g., '393922348132@c.us')
 * @returns {object|null} The member object or null if not found
 */
function findMemberByWa(jid) {
  const phone = jid.split('@')[0].split(':')[0];
  return ACTIVE_MEMBERS.find(m => m.wa.split('@')[0] === phone) || null;
}

/**
 * Find a member by Discord username, display name, or server nickname.
 * @param {string} username - Discord username
 * @param {string} displayName - Discord display name
 * @param {string} nickname - Discord server nickname
 * @returns {object|null} The member object or null if not found
 */
function findMemberByDiscord(username, displayName, nickname) {
  const candidates = [username, displayName, nickname].filter(Boolean).map(n => n.toLowerCase());
  return ACTIVE_MEMBERS.find(m =>
    m.nicks.some(nick => candidates.includes(nick.toLowerCase()))
  ) || null;
}

/**
 * Find a member by full name (case-insensitive).
 * @param {string} name - Full member name
 * @returns {object|null} The member object or null if not found
 */
function findMemberByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  return ACTIVE_MEMBERS.find(m => m.name.toLowerCase() === lower) || null;
}

/**
 * Check if a member has admin privileges.
 * @param {object|null} member - The member object
 * @returns {boolean} True if member exists and has admin flag set to true
 */
function isAdmin(member) {
  return member !== null && member.admin === true;
}

module.exports = { ACTIVE_MEMBERS, findMemberByWa, findMemberByDiscord, findMemberByName, isAdmin };
