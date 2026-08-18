// src/utils/settingsStore.js
//
// Persistent per-chat preferences (users and groups), stored as one small JSON
// file per chat under data/memories/. Holds the TTS voice, reasoning effort,
// reply language and the free-text custom memory, plus the timestamps used for
// the monthly renewal notice.
//
// Written by the `manage_preferences` tool and read on every turn to render the
// <CurrentSettings> prompt block.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { getRomeISO  } from './time.js';
import { withKeyedLock  } from './keyedLock.js';
import {
  PROVIDER,
  XAI_EFFORTS,
  OPENAI_EFFORTS,
  profileFromContext
} from '../ai/providers/providerProfile.js';

const SETTINGS_DIR = path.join(constants.DATA_DIR, 'memories');
const MAX_MEMORY_CHARS = 1000;

/** Interval after which GemiX asks the user to confirm custom preferences. */
const SETTINGS_REVIEW_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** xAI TTS voices, grouped by gender (the tool exposes both groups). */
const VOICES_FEMALE = ['eve', 'ara', 'carina', 'luna', 'iris', 'altair', 'celeste', 'ursa', 'lumen'];
const VOICES_MALE = ['leo', 'rex', 'zagan', 'helix', 'orion', 'perseus', 'helios', 'lux', 'kepler', 'rigel', 'cosmo', 'sirius', 'castor', 'naksh', 'atlas'];
const VALID_VOICES = [...VOICES_MALE, ...VOICES_FEMALE];

/**
 * Reasoning effort levels accepted for the main brain, per provider. Each
 * profile keeps its own stored value, so switching providers restores the
 * effort that profile was last set to instead of leaking one into the other.
 */
const EFFORTS_BY_PROVIDER = {
  [PROVIDER.XAI]: XAI_EFFORTS,
  [PROVIDER.OPENAI]: OPENAI_EFFORTS
};

/** @deprecated for new code — the xAI levels, kept for callers pinned to that profile. */
const VALID_EFFORTS = XAI_EFFORTS;

/**
 * Effort values the given provider accepts.
 * @param {object} [ctx] - anything carrying providerProfile/providerId
 * @returns {string[]}
 */
function effortsForProvider(ctx) {
  return EFFORTS_BY_PROVIDER[profileFromContext(ctx).id] || XAI_EFFORTS;
}

/** Supported reply/TTS languages (BCP-47-ish codes accepted by xAI TTS). */
const VALID_LANGUAGES = [
  'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it',
  'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'es-MX', 'es-ES', 'tr', 'vi'
];

/** Default free-text memory: the voice-vs-text guidance every chat starts with. */
const DEFAULT_MEMORY =
  'Use voice replies (voice:true) for short, casual, non-technical messages; use text for long or technical ones. '
  + 'Vary voice vs text across your recent replies so you are not repetitive. '
  + 'Use emojis sometimes.';

/**
 * Program defaults for the given provider. The xAI voice comes from .env
 * (envConfig.XAI_TTS_VOICE) so the deployment decides the starting voice; the
 * OpenAI profile has no voice preference at all, because Google Translate TTS
 * offers no voice catalog to choose from.
 * @param {object} [ctx] - anything carrying providerProfile/providerId
 * @returns {{ voice?: string, effort: string, language: string, memory: string }}
 */
function defaultSettings(ctx) {
  const provider = profileFromContext(ctx);
  const base = {
    effort: provider.defaultEffort,
    language: 'it',
    memory: DEFAULT_MEMORY
  };
  if (!provider.capabilities.namedVoices) return base;
  return { voice: envConfig.XAI_TTS_VOICE, ...base };
}

/** Preference keys the given provider actually exposes, in display order. */
function visibleSettingFields(ctx) {
  const provider = profileFromContext(ctx);
  return provider.capabilities.namedVoices
    ? ['voice', 'effort', 'language', 'memory']
    : ['effort', 'language', 'memory'];
}

if (!fs.existsSync(SETTINGS_DIR)) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

// Per-file async lock to prevent concurrent read-modify-write race conditions.
const _locks = new Map();

const _withLock = (fileId, fn) => withKeyedLock(_locks, fileId, fn);

function _filePath(fileId) {
  return path.join(SETTINGS_DIR, `${fileId}.json`);
}

function _readRawUnlocked(fileId) {
  try {
    return JSON.parse(fs.readFileSync(_filePath(fileId), 'utf-8'));
  } catch {
    return null;
  }
}

function _writeRawUnlocked(fileId, data) {
  const filePath = _filePath(fileId);
  const tempFile = filePath + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    }
    return { success: false, error: err.message };
  }
  return { success: true };
}

/**
 * The stored effort for one provider. `effortByProvider` is the current shape;
 * a bare `effort` is the pre-provider value and belongs to the xAI profile, so
 * an OpenAI chat starts from its own default instead of inheriting it.
 * @param {object} stored - raw settings file contents
 * @param {object} provider - ProviderProfile
 * @returns {string|null} a valid stored effort, or null when there is none
 */
function _storedEffort(stored, provider) {
  const allowed = EFFORTS_BY_PROVIDER[provider.id] || XAI_EFFORTS;
  const perProvider = stored.effortByProvider;
  if (perProvider && typeof perProvider === 'object' && allowed.includes(perProvider[provider.id])) {
    return perProvider[provider.id];
  }
  if (provider.id === PROVIDER.XAI && allowed.includes(stored.effort)) return stored.effort;
  return null;
}

/**
 * Read the effective settings for a chat: stored values merged over the
 * program defaults, so callers always get a complete object. Only the fields
 * the active provider exposes are returned — the other profile's stored values
 * stay on disk untouched, ready for a rollback.
 * @param {string} fileId - Settings file ID (e.g. 'memory_wa_39...').
 * @param {object} [ctx] - anything carrying providerProfile/providerId
 * @returns {{ voice?: string, effort: string, language: string, memory: string, updatedAt: string|null, reviewedAt: string|null }}
 */
function readSettings(fileId, ctx) {
  const provider = profileFromContext(ctx);
  const defaults = defaultSettings(provider);
  const stored = fileId ? _readRawUnlocked(fileId) : null;
  if (!stored || typeof stored !== 'object') {
    return { ...defaults, updatedAt: null, reviewedAt: null };
  }
  const settings = {
    effort: _storedEffort(stored, provider) ?? defaults.effort,
    language: VALID_LANGUAGES.includes(stored.language) ? stored.language : defaults.language,
    memory: typeof stored.memory === 'string' && stored.memory.trim() ? stored.memory : defaults.memory,
    updatedAt: stored.updatedAt || null,
    reviewedAt: stored.reviewedAt || null
  };
  if (provider.capabilities.namedVoices) {
    settings.voice = VALID_VOICES.includes(stored.voice) ? stored.voice : defaults.voice;
  }
  return settings;
}

/**
 * Which settings differ from the program defaults. Scoped to the fields the
 * active provider shows, so a customized xAI voice never marks an OpenAI chat
 * as customized (and never triggers its renewal notice).
 * @param {object} settings - Effective settings (from readSettings).
 * @param {object} [ctx] - anything carrying providerProfile/providerId
 * @returns {string[]} Names of the customized fields.
 */
function customizedFields(settings, ctx) {
  const provider = profileFromContext(ctx);
  const defaults = defaultSettings(provider);
  return visibleSettingFields(provider).filter(k => settings[k] !== defaults[k]);
}

/** True when at least one setting was changed by the user. */
function hasCustomSettings(settings, ctx) {
  return customizedFields(settings, ctx).length > 0;
}

/**
 * Apply a partial update and stamp `updatedAt`. Only the provided keys change,
 * so the tool can touch a single preference at a time.
 * @param {string} fileId
 * @param {{ voice?: string, effort?: string, language?: string, memory?: string }} patch
 * @returns {Promise<{ success: boolean, error?: string, settings?: object }>}
 */
async function updateSettings(fileId, patch, ctx) {
  if (!fileId) return { success: false, error: 'Unable to identify the settings file for this chat.' };
  const provider = profileFromContext(ctx);
  return _withLock(fileId, async () => {
    const stored = _readRawUnlocked(fileId) || {};
    const next = { ...stored };
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue;
      // Effort is per provider: write the active profile's slot and leave the
      // other one alone. The legacy flat `effort` stays in sync for xAI so a
      // rollback to an older build still reads the value the user chose.
      if (key === 'effort') {
        next.effortByProvider = { ...(next.effortByProvider || {}), [provider.id]: value };
        if (provider.id === PROVIDER.XAI) next.effort = value;
        continue;
      }
      next[key] = value;
    }
    next.updatedAt = getRomeISO();
    // A change restarts the renewal cycle.
    next.reviewedAt = next.updatedAt;
    const written = _writeRawUnlocked(fileId, next);
    if (!written.success) return written;
    return { success: true, settings: readSettings(fileId, provider) };
  });
}

/**
 * Whether the monthly renewal notice is due: only for chats with at least one
 * custom preference, and only once per interval.
 * @param {object} settings - Effective settings (from readSettings).
 * @param {number} [now]
 * @returns {boolean}
 */
function isReviewDue(settings, now = Date.now(), ctx) {
  if (!hasCustomSettings(settings, ctx)) return false;
  const anchor = settings.reviewedAt || settings.updatedAt;
  // Custom values with no timestamp (hand-edited file): ask on the next turn.
  if (!anchor) return true;
  const anchorTime = new Date(anchor).getTime();
  if (!Number.isFinite(anchorTime)) return true;
  return now - anchorTime >= SETTINGS_REVIEW_INTERVAL_MS;
}

/**
 * Record that the renewal notice was injected. It counts as the review even if
 * GemiX never mentions it or the user ignores it, so the notice cannot loop.
 * Throws if the write fails so callers do not treat the notice as recorded.
 * @param {string} fileId
 * @returns {Promise<void>}
 */
async function markReviewed(fileId) {
  if (!fileId) return;
  await _withLock(fileId, async () => {
    const stored = _readRawUnlocked(fileId);
    // Nothing stored means everything is default: no review to record.
    if (!stored || typeof stored !== 'object') return;
    stored.reviewedAt = getRomeISO();
    const written = _writeRawUnlocked(fileId, stored);
    if (!written.success) {
      throw new Error(written.error || 'Failed to write reviewedAt');
    }
  });
}

/**
 * Combine incoming memory text with the stored memory.
 * @param {string|null} existing
 * @param {string} content
 * @param {boolean} replace - true = overwrite; false = append
 * @returns {{ content: string, cleared: boolean }}
 */
function resolveMemoryContent(existing, content, replace) {
  const incoming = typeof content === 'string' ? content : '';
  if (!incoming.trim()) {
    return { content: '', cleared: true };
  }
  if (replace) {
    return { content: incoming, cleared: false };
  }
  const prior = typeof existing === 'string' ? existing.trim() : '';
  if (!prior) {
    return { content: incoming, cleared: false };
  }
  return { content: `${prior}\n${incoming.trim()}`, cleared: false };
}

export {
  MAX_MEMORY_CHARS,
  DEFAULT_MEMORY,
  VOICES_MALE,
  VOICES_FEMALE,
  VALID_VOICES,
  VALID_EFFORTS,
  EFFORTS_BY_PROVIDER,
  effortsForProvider,
  VALID_LANGUAGES,
  defaultSettings,
  visibleSettingFields,
  readSettings,
  updateSettings,
  customizedFields,
  isReviewDue,
  markReviewed,
  resolveMemoryContent

};
