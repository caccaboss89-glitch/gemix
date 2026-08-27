// src/tools/preferences.js
//
// Tool directives: all tool-facing text is in English, uses no emojis, no XML
// wrappers, and results are returned as plain objects so the dispatcher
// serializes a fixed JSON `{ success, message?, error?, ... }` envelope.
//
// Implementation of the `manage_preferences` tool: writes the per-chat settings
// shown in the <CurrentSettings> prompt block (TTS voice, reasoning effort,
// reply language, and the free-text custom memory).
//
// Only the fields the model actually passes are changed; the `updatedAt` stamp
// is written by the system, never by the model.

import {
  updateSettings,
  readSettings,
  resolveMemoryContent,
  MAX_MEMORY_CHARS,
  VALID_VOICES,
  VALID_LANGUAGES,
  DEFAULT_MEMORY,
  activeEffortPolicy
} from '../utils/settingsStore.js';

/**
 * Apply a preferences update for the current chat.
 * @param {object} args - { voice?, effort?, language?, memory?, replace? }
 * @param {string} settingsFileId - Settings file ID for this chat.
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
async function managePreferences(args, settingsFileId) {
  if (!settingsFileId) {
    return { success: false, error: 'Unable to identify the settings file for this chat.' };
  }

  const patch = {};
  const current = readSettings(settingsFileId);

  if (args.voice !== undefined && args.voice !== null && args.voice !== '') {
    const voice = String(args.voice).trim().toLowerCase();
    if (!VALID_VOICES.includes(voice)) {
      return { success: false, error: `Invalid voice: "${args.voice}". Available voices: ${VALID_VOICES.join(', ')}.` };
    }
    patch.voice = voice;
  }

  if (args.effort !== undefined && args.effort !== null && args.effort !== '') {
    const { supportedEfforts } = activeEffortPolicy();
    const effort = String(args.effort).trim().toLowerCase();
    if (!supportedEfforts.includes(effort)) {
      return { success: false, error: `Invalid effort: "${args.effort}". Use one of: ${supportedEfforts.join(', ')}.` };
    }
    patch.effort = effort;
  }

  if (args.language !== undefined && args.language !== null && args.language !== '') {
    const language = String(args.language).trim();
    const match = VALID_LANGUAGES.find(l => l.toLowerCase() === language.toLowerCase());
    if (!match) {
      return { success: false, error: `Invalid language: "${args.language}". Use one of: ${VALID_LANGUAGES.join(', ')}.` };
    }
    patch.language = match;
  }

  let memoryNote = '';
  if (args.memory !== undefined && args.memory !== null) {
    const resolved = resolveMemoryContent(current.memory, args.memory, args.replace !== false);
    if (resolved.cleared) {
      // Clearing restores the default guidance rather than leaving it empty.
      patch.memory = DEFAULT_MEMORY;
      memoryNote = ' Memory reset to the default guidance.';
    } else {
      if (resolved.content.length > MAX_MEMORY_CHARS) {
        return {
          success: false,
          error: `Memory exceeds the ${MAX_MEMORY_CHARS} character limit (${resolved.content.length} chars).`
        };
      }
      patch.memory = resolved.content;
      const mode = args.replace === false ? 'appended to' : 'updated';
      memoryNote = ` Memory ${mode} (${resolved.content.length}/${MAX_MEMORY_CHARS} chars).`;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'Nothing to update: pass at least one of voice, effort, language, memory.' };
  }

  const changedKeys = Object.keys(patch).filter(key => patch[key] !== current[key]);
  if (changedKeys.length === 0) {
    return {
      success: true,
      changed: false,
      settings: current,
      message: 'Preferences already matched these values; nothing was written.'
    };
  }

  const changedPatch = Object.fromEntries(changedKeys.map(key => [key, patch[key]]));
  const written = await updateSettings(settingsFileId, changedPatch);
  if (!written.success) {
    return { success: false, error: written.error };
  }

  const changes = changedKeys.map(key => key === 'memory' ? 'memory' : `${key}=${patch[key]}`);
  const effectiveMemoryNote = changedKeys.includes('memory') ? memoryNote : '';
  return {
    success: true,
    changed: true,
    settings: written.settings,
    message: `Preferences updated (${changes.join(', ')}).${effectiveMemoryNote} `
      + 'The new values are active from your next reply.'
  };
}

export { managePreferences };
