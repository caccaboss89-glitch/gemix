// src/config/members.js
//
// Active member registry.
//
// The member list is stored in src/data/members.json (gitignored).
// This module loads the active members at startup.
//
// If the members file is missing or invalid, the loader returns an empty list.
import fs from 'fs';
import path from 'path';
import constants from './constants.js';
import envConfig from './env.js';
import { createLogger } from '../utils/logger.js';

const { DATA_DIR } = constants;

const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');

const log = createLogger('Members');

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

  log.error(
    `No members file found at ${MEMBERS_FILE}.\n` +
    'The active members list must be provided in a JSON file (see src/data/members.json).'
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
      error: `Multiple members match "${trimmed}": ${names}. Specify a more precise name.`
    };
  }
  return { ok: true, member: matches[0] };
}

/**
 * Report a role holder that .env and the member file disagree about.
 *
 * Each role is stated twice: as a name in .env, which prompts and tool schemas
 * quote, and as a flag here, which decides what the model is told about the
 * caller. Nothing forced the two to agree, and they silently did not -
 * LEGAL_NAME named the advisor while no member carried `legal`, so the role
 * never reached a prompt. A mismatch costs a label, not the roster, so it is
 * reported and startup continues.
 *
 * @param {string} envValue - the name configured in .env
 * @param {'admin'|'legal'} flag - the member field that grants the role
 * @param {string} envKey - the variable name, for the message
 */
function _reportRoleMismatch(envValue, flag, envKey) {
  const resolved = resolveActiveMemberByName(envValue);
  if (!resolved.ok) {
    log.warn(`${envKey}="${envValue}" does not name an active member: ${resolved.error}`);
  } else if (resolved.member[flag] !== true) {
    log.warn(
      `${envKey}="${envValue}" names ${resolved.member.name}, who has no "${flag}": true `
      + `in ${MEMBERS_FILE}. The role will not appear in any prompt.`
    );
  }
  for (const holder of ACTIVE_MEMBERS.filter((m) => m[flag] === true)) {
    if (!resolved.ok || holder !== resolved.member) {
      log.warn(`${holder.name} has "${flag}": true but ${envKey} is "${envValue}".`);
    }
  }
}

_reportRoleMismatch(envConfig.ADMIN_NAME, 'admin', 'ADMIN_NAME');
_reportRoleMismatch(envConfig.LEGAL_NAME, 'legal', 'LEGAL_NAME');

/**
 * Find a member by WhatsApp JID.
 * @param {string} jid - WhatsApp JID (e.g., '390000000000@c.us')
 * @returns {object|null} The member object or null if not found
 */
function findMemberByWa(jid) {
  const phone = jid.split('@')[0].split(':')[0];
  return ACTIVE_MEMBERS.find(m => {
    if (typeof m.wa !== 'string' || !m.wa) return false;
    return m.wa.split('@')[0] === phone;
  }) || null;
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
    Array.isArray(m.nicks) && m.nicks.some(nick => candidates.includes(String(nick).toLowerCase()))
  ) || null;
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
 * @param {object|null|undefined} member - The member object
 * @returns {boolean} True if member exists and has admin flag set to true
 */
function isAdmin(member) {
  return member && member.admin === true;
}

/**
 * Check if a member has legal advisor privileges.
 * @param {object|null|undefined} member - The member object
 * @returns {boolean} True if member exists and has legal flag set to true
 */
function isLegal(member) {
  return member && member.legal === true;
}

/**
 * Extract role flags from a member object.
 * @param {object|null} member - The member object
 * @returns {{ isAdmin: boolean, isLegal: boolean }} Role flags
 */
function getRoles(member) {
  return {
    isAdmin: isAdmin(member),
    isLegal: isLegal(member)
  };
}

/**
 * Format a member's role label for prompt display.
 * Centralizes the logic for how roles are presented to the model.
 * @param {object|null} member - The member object
 * @returns {string} Role label (empty string if no roles, e.g. "GemiX creator and Discord server administrator")
 */
function formatRoleLabel(member) {
  const roles = getRoles(member);
  if (!roles.isAdmin && !roles.isLegal) return '';

  if (roles.isAdmin && roles.isLegal) {
    return 'GemiX creator and Discord server administrator, legal advisor';
  }
  if (roles.isAdmin) {
    return 'GemiX creator and Discord server administrator';
  }
  if (roles.isLegal) {
    return 'Legal advisor';
  }
  return '';
}

export {
  ACTIVE_MEMBERS,
  findMemberByWa,
  findMemberByDiscord,
  findMemberByEmail,
  resolveActiveMemberByName,
  isAdmin,
  isLegal,
  getRoles,
  formatRoleLabel
};