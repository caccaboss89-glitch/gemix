// src/sandbox/skillsLibrary.js
//
// The skill library: what is installed under `skills/`, and the one line each
// installed skill contributes to the system prompt.
//
// A skill is a directory holding a `SKILL.md` whose YAML frontmatter declares a
// `name` and a `description`. Only that frontmatter reaches the prompt. The
// body of SKILL.md, and any script, reference or asset beside it, is read with
// `read_file` when the model decides from the description that the skill
// applies — which is the whole point of the split: the catalog costs a line per
// skill, the procedure costs nothing until it is used.
//
// The library is one directory for the whole deployment, shipped with the repo
// and mounted read-only: the skills are ours, not something the model adds to.
// It still changes under a running process — a deploy pulls new ones — so the
// catalog is re-read whenever a SKILL.md is added, changed or removed, and
// cached in between: a stale prompt would advertise a skill that is not there.
//
// The listing and the reads go through the descriptor-safe host gateway, like
// every other path the model can name.

import constants from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { listAgentDirectory, readAgentFileBuffer, statAgentFile } from './hostFileGateway.js';
import { ROOT, toDisplayPath } from './workspacePaths.js';

const log = createLogger('SkillsLibrary');

/** The file that makes a directory a skill. */
const SKILL_FILE = 'SKILL.md';

/**
 * The library's host root resolver ignores the workspace id — it is the same
 * directory for every conversation — so the gateway is called without one.
 */
const SHARED_LIBRARY = null;

/** Ceiling on one SKILL.md. Frontmatter plus a procedure, never a data file. */
const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Ceiling on one description in the prompt, so a runaway line cannot grow it. */
const MAX_DESCRIPTION_CHARS = 400;

/** { signature, skills } for as long as no SKILL.md changed. */
let _cache = null;

/**
 * Scalar YAML frontmatter at the head of a document.
 *
 * Deliberately minimal: `key: value` lines between the opening and closing
 * `---`, with optional surrounding quotes. A skill that needs anything richer
 * than that is describing itself in the body, which is where detail belongs.
 *
 * @param {string} text
 * @returns {Record<string, string>|null} null when there is no frontmatter block
 */
function parseFrontmatter(text) {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text || '');
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (value) fields[pair[1].toLowerCase()] = value;
  }
  return fields;
}

/** Collapse a description to one prompt line, bounded. */
function _normalizeDescription(raw) {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/**
 * Every `<skill>/SKILL.md` in the library, with the size and mtime that decide
 * whether the cached catalog is still current. Only top-level directories are
 * enumerated: assets inside a skill cannot consume a cap or hide a later
 * manifest.
 * @returns {Array<{ dir: string, relPath: string, size: number, mtimeMs: number }>}
 */
function _skillFileEntries() {
  const listing = listAgentDirectory(SHARED_LIBRARY, toDisplayPath(ROOT.SKILLS, ''), {
    depth: 1,
    limit: constants.WORKSPACE_MAX_ENTRIES
  });
  if (!listing) return [];
  if (!listing.complete) log.warn('Skill discovery stopped at the bounded inventory limit');
  const entries = [];
  for (const dir of listing.dirs) {
    if (dir.includes('/')) continue;
    const relPath = `${dir}/${SKILL_FILE}`;
    const manifest = statAgentFile(SHARED_LIBRARY, toDisplayPath(ROOT.SKILLS, relPath));
    if (!manifest) continue;
    entries.push({ dir, relPath, size: manifest.stat.size, mtimeMs: manifest.stat.mtimeMs });
  }
  return entries;
}

/** Read and validate one skill, or null when it does not declare itself. */
function _readSkill(entry) {
  const display = toDisplayPath(ROOT.SKILLS, entry.relPath);
  let read;
  try {
    read = readAgentFileBuffer(SHARED_LIBRARY, display, MAX_SKILL_FILE_BYTES);
  } catch (err) {
    log.warn(`${display} ignored: ${err.message}`);
    return null;
  }
  if (!read) {
    log.warn(`${display} ignored: it could not be opened as a regular file`);
    return null;
  }

  const fields = parseFrontmatter(read.buffer.toString('utf-8'));
  if (!fields || !fields.description) {
    log.warn(`${display} ignored: its frontmatter declares no description`);
    return null;
  }
  // The directory is where the skill actually lives, so it settles the name and
  // a frontmatter that disagrees is reported rather than obeyed.
  if (fields.name && fields.name !== entry.dir) {
    log.warn(`${display} declares name "${fields.name}" but sits in "${entry.dir}"; using the directory name`);
  }
  return {
    name: entry.dir,
    description: _normalizeDescription(fields.description),
    path: display
  };
}

/**
 * The installed skills, name-ordered.
 *
 * @returns {Array<{ name: string, description: string, path: string }>}
 */
function listInstalledSkills() {
  const entries = _skillFileEntries();
  const signature = entries
    .map(e => `${e.relPath}:${e.size}:${e.mtimeMs}`)
    .sort()
    .join('|');
  if (_cache && _cache.signature === signature) return _cache.skills;

  const skills = entries
    .map(_readSkill)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  _cache = { signature, skills };
  return skills;
}

/** Absolute host path of the library, for operator-facing messages. */
function skillsLibraryPath() {
  return constants.SKILLS_DIR;
}

/** Drop the cached catalog. Tests only — a live process re-reads on change. */
function _resetSkillsCacheForTests() {
  _cache = null;
}

export {
  SKILL_FILE,
  listInstalledSkills,
  parseFrontmatter,
  skillsLibraryPath,
  _resetSkillsCacheForTests
};
