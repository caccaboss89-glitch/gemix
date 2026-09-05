// src/config/members.js
//
// Active member registry.
//
// The member list is stored in src/data/members.json (gitignored).
// This module loads the active members at startup.
//
// It is also the only place a role is configured: the `admin` and `legal`
// flags decide both what the model is told about the caller and who
// ADMIN_NAME / LEGAL_NAME name, so the two can no longer disagree.
//
// If the members file is missing or invalid, the loader returns an empty list.
import fs from 'fs';
import path from 'path';
import constants from './constants.js';
import { createLogger } from '../utils/logger.js';

const { DATA_DIR } = constants;

const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');

const log = createLogger('Members');

function _validateMembers(value) {
  const errors = [];
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, errors: ['members.json must contain a non-empty array.'], members: [] };
  }
  const members = [];
  value.forEach((member, index) => {
    const prefix = `members[${index}]`;
    const fields = [];
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    if (typeof member.name !== 'string' || !member.name.trim()) fields.push('name must be a non-empty string');
    if (!Array.isArray(member.nicks) || member.nicks.some(nick => typeof nick !== 'string' || !nick.trim())) {
      fields.push('nicks must be an array of non-empty strings');
    }
    if (typeof member.email !== 'string' || !member.email.trim()) fields.push('email must be a non-empty string');
    if (typeof member.wa !== 'string' || !member.wa.trim()) fields.push('wa must be a non-empty string');
    for (const role of ['admin', 'legal']) {
      if (member[role] !== undefined && typeof member[role] !== 'boolean') {
        fields.push(`${role} must be boolean when present`);
      }
    }
    if (fields.length > 0) errors.push(`${prefix}: ${fields.join('; ')}.`);
    else members.push(member);
  });
  return { ok: errors.length === 0, errors, members: errors.length === 0 ? members : [] };
}

function _loadMembers() {
  try {
    if (fs.existsSync(MEMBERS_FILE)) {
      const raw = fs.readFileSync(MEMBERS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      const validation = _validateMembers(parsed);
      if (validation.ok) {
        log.info(`Loaded ${validation.members.length} active member(s) from ${MEMBERS_FILE}`);
        return validation.members;
      }
      log.error(`Members file at ${MEMBERS_FILE} is invalid:\n${validation.errors.join('\n')}`);
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
 * The name behind a role, read from the flag that grants it.
 *
 * Each role used to be configured twice - a name in .env and a flag here - and
 * the two drifted apart in silence: .env named the legal advisor while no
 * member carried `legal`, so isLegal was false for everyone and the role never
 * reached a prompt. The flag is what the code acts on, so it is also where the
 * name comes from, and there is nothing left to keep in sync.
 *
 * Both roles are singular by design: the prompts name one account owner and
 * one advisor. A second holder is a mistake worth saying out loud, not worth
 * refusing to start over.
 *
 * @param {'admin'|'legal'} flag - the member field that grants the role
 * @param {string} label - the role, for the message
 * @returns {string} The holder's name, or an empty string if nobody holds it
 */
function _roleHolderName(flag, label) {
  const holders = ACTIVE_MEMBERS.filter((m) => m[flag] === true);
  if (holders.length === 0) {
    log.warn(`No active member has "${flag}": true in ${MEMBERS_FILE}, so nothing names the ${label}.`);
    return '';
  }
  if (holders.length > 1) {
    log.warn(
      `${holders.length} active members have "${flag}": true (${holders.map((m) => m.name).join(', ')}); `
      + `treating ${holders[0].name} as the ${label}.`
    );
  }
  return holders[0].name;
}

const ADMIN_NAME = _roleHolderName('admin', 'administrator');
const LEGAL_NAME = _roleHolderName('legal', 'legal advisor');

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
  return member?.admin === true;
}

/**
 * Check if a member has legal advisor privileges.
 * @param {object|null|undefined} member - The member object
 * @returns {boolean} True if member exists and has legal flag set to true
 */
function isLegal(member) {
  return member?.legal === true;
}

/**
 * A member's roles as the prompt names them, in one shape for both places that
 * name them: the <ActiveMembers> roster and the <Caller> line, where the label
 * sits inside a parenthesis after the member's name. Both roles are lower case
 * bar the proper noun, so a label reads as one item of that parenthesis rather
 * than as a sentence of its own.
 *
 * @param {object|null} member - The member object
 * @returns {string} e.g. "GemiX creator and Discord server administrator";
 *   empty when the member holds no role
 */
function formatRoleLabel(member) {
  const roles = [];
  if (isAdmin(member)) roles.push('GemiX creator and Discord server administrator');
  if (isLegal(member)) roles.push('legal advisor');
  return roles.join(', ');
}

export {
  ACTIVE_MEMBERS,
  ADMIN_NAME,
  LEGAL_NAME,
  findMemberByWa,
  findMemberByDiscord,
  findMemberByEmail,
  resolveActiveMemberByName,
  isAdmin,
  isLegal,
  formatRoleLabel,
  _validateMembers
};
