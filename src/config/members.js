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
const { createLogger } = require('../utils/logger');

const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');

const log = createLogger('Members');

// Fallback members list.
// Empty because active members are loaded from src/data/members.json.
// Supports fallback in the loading logic.
const _LEGACY_HARDCODED_MEMBERS = [];

function _loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) {
      const raw = fs.readFileSync(MEMBERS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed) && parsed.length > 0) {
        log.info(`Loaded ${parsed.length} active member(s) from ${MEMBERS_FILE}`);
        return parsed;
      }

      log.warn(`Members file at ${MEMBERS_FILE} exists but is empty or invalid. No members loaded.`);
      return [];
    }
  } catch (err) {
    log.error(`Failed to read members file at ${MEMBERS_FILE}: ${err.message}`);
  }

  // No valid members file found
  if (_LEGACY_HARDCODED_MEMBERS.length > 0) {
    log.warn('Falling back to legacy hardcoded members list (not recommended for production).');
    return _LEGACY_HARDCODED_MEMBERS;
  }

  log.error(
    `No members file found at ${MEMBERS_FILE}.\n` +
    `The active members list must be provided in a JSON file (see src/data/members.json).`
  );

  return [];
}

const ACTIVE_MEMBERS = _loadMembers();

function _tokenizeMemberName(name) {
  if (typeof name !== 'string') return [];
  return name.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** Tokens used for flexible name lookup (legal name + Discord/WhatsApp nicks). */
function _memberSearchTokens(member) {
  const tokens = new Set(_tokenizeMemberName(member.name));
  if (Array.isArray(member.nicks)) {
    for (const nick of member.nicks) {
      for (const t of _tokenizeMemberName(nick)) {
        tokens.add(t);
        const stripped = t.replace(/\d+$/, '');
        if (stripped.length >= 3 && stripped !== t) tokens.add(stripped);
      }
    }
  }
  return [...tokens];
}

/**
 * Resolve an active member by full name, surname, given name(s), or any
 * token subset (order-independent). Returns an ambiguity error when multiple
 * members share the same matching token(s).
 *
 * @param {string} query
 * @returns {{ ok: true, member: object } | { ok: false, error: string }}
 */
function resolveActiveMemberByName(query) {
  if (!query || typeof query !== 'string') {
    return { ok: false, error: 'Member name is required.' };
  }
  const trimmed = query.trim();
  const qTokens = _tokenizeMemberName(trimmed);
  if (qTokens.length === 0) {
    return { ok: false, error: 'Member name is required.' };
  }

  const matches = ACTIVE_MEMBERS.filter((m) => {
    const mTokens = _memberSearchTokens(m);
    return qTokens.every((t) => mTokens.includes(t));
  });

  if (matches.length === 0) {
    return { ok: false, error: `Member "${trimmed}" not found.` };
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m.name).join(', ');
    return {
      ok: false,
      error: `Multiple members match "${trimmed}": ${names}. Specify a more precise name.`,
    };
  }
  return { ok: true, member: matches[0] };
}

/**
 * Find a member by WhatsApp JID.
 * @param {string} jid - WhatsApp JID (e.g., '390000000000@c.us')
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
 * Find a member by name query (see resolveActiveMemberByName).
 * @param {string} name
 * @returns {object|null}
 */
function findMemberByName(name) {
  const resolved = resolveActiveMemberByName(name);
  return resolved.ok ? resolved.member : null;
}

/**
 * Find a member by email address (case-insensitive).
 * @param {string} email
 * @returns {object|null} The member object or null if not found
 */
function findMemberByEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return ACTIVE_MEMBERS.find(m => m.email && m.email.toLowerCase() === normalized) || null;
}

/**
 * Check if a member has admin privileges.
 * @param {object|null} member - The member object
 * @returns {boolean} True if member exists and has admin flag set to true
 */
function isAdmin(member) {
  return member !== null && member.admin === true;
}

module.exports = {
  ACTIVE_MEMBERS,
  findMemberByWa,
  findMemberByDiscord,
  findMemberByName,
  findMemberByEmail,
  resolveActiveMemberByName,
  isAdmin,
};