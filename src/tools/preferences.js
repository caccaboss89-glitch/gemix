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
  VALID_EFFORTS,
  VALID_LANGUAGES,
  DEFAULT_MEMORY
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
  const changes = [];

  if (args.voice !== undefined && args.voice !== null && args.voice !== '') {
    const voice = String(args.voice).trim().toLowerCase();
    if (!VALID_VOICES.includes(voice)) {
      return { success: false, error: `Invalid voice: "${args.voice}". Available voices: ${VALID_VOICES.join(', ')}.` };
    }
    patch.voice = voice;
    changes.push(`voice=${voice}`);
  }

  if (args.effort !== undefined && args.effort !== null && args.effort !== '') {
    const effort = String(args.effort).trim().toLowerCase();
    if (!VALID_EFFORTS.includes(effort)) {
      return { success: false, error: `Invalid effort: "${args.effort}". Use one of: ${VALID_EFFORTS.join(', ')}.` };
    }
    patch.effort = effort;
    changes.push(`effort=${effort}`);
  }

  if (args.language !== undefined && args.language !== null && args.language !== '') {
    const language = String(args.language).trim();
    const match = VALID_LANGUAGES.find(l => l.toLowerCase() === language.toLowerCase());
    if (!match) {
      return { success: false, error: `Invalid language: "${args.language}". Use one of: ${VALID_LANGUAGES.join(', ')}.` };
    }
    patch.language = match;
    changes.push(`language=${match}`);
  }

  let memoryNote = '';
  if (args.memory !== undefined && args.memory !== null) {
    const current = readSettings(settingsFileId);
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
    changes.push('memory');
  }

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'Nothing to update: pass at least one of voice, effort, language, memory.' };
  }

  const written = await updateSettings(settingsFileId, patch);
  if (!written.success) {
    return { success: false, error: written.error };
  }

  return {
    success: true,
    message: `Preferences updated (${changes.join(', ')}).${memoryNote} `
      + 'The new values are active from your next reply.'
  };
}

export default { managePreferences };
