// src/config/members.js
//
// Active member registry.
//
// PII separation: by default the registry is loaded from a non-tracked file
// at data/members.json (added to .gitignore). If that file is missing, we
// fall back to the legacy hardcoded list below so existing deployments do
// not regress. Override path with GEMIX_MEMBERS_FILE if you keep the
// registry elsewhere (encrypted store, secrets vault, etc.).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./constants');
const { createLogger } = require('../utils/logger');

const log = createLogger('Members');

const _LEGACY_HARDCODED_MEMBERS = [
  {
    name: 'Gagliardi Alberto',
    nicks: ['抜刀隊', 'SecondoAccount89'],
    email: 'albertogagliardi08@gmail.com',
    wa: '393922348132@c.us',
    admin: true,
  },
  {
    name: 'Passante Lorenzo',
    nicks: ['lorenzo419', 'Blanc_et_Noir08'],
    email: 'passante.lorenzo.00@gmail.com',
    wa: '393518682781@c.us',
  },
  {
    name: 'Ceraj Gabriel',
    nicks: ['TEDESCODURO'],
    email: 'g.ceraj08@gmail.com',
    wa: '4917672773104@c.us',
  },
  {
    name: 'Fabiano Christian Nicola',
    nicks: ['niky09'],
    email: 'nicola.fabiano2009@gmail.com',
    wa: '393669729298@c.us',
  },
  {
    name: 'Biclea Alexandru Antonio',
    nicks: ['Lil Alex', 'Lil_NGA'],
    email: 'alexbicleajr@gmail.com',
    wa: '393278547055@c.us',
  },
];

function _loadMembers() {
  const customPath = process.env.GEMIX_MEMBERS_FILE && process.env.GEMIX_MEMBERS_FILE.trim();
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
      log.warn(`Members file at ${candidate} is empty or not an array, falling back to legacy list.`);
    }
  } catch (err) {
    log.warn(`Failed to read members file at ${candidate}: ${err.message} — falling back to legacy list.`);
  }
  return _LEGACY_HARDCODED_MEMBERS;
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
