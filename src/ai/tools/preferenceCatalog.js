// src/ai/tools/preferenceCatalog.js
//
// Per-chat preferences and notification settings.

import {
  activeEffortPolicy,
  defaultSettings,
  VALID_LANGUAGES,
  VALID_VOICES,
  VOICES_FEMALE,
  VOICES_MALE
} from '../../utils/settingsStore.js';
import { makeTool } from './schema.js';

function buildManagePreferencesTool(isGroup, isPersonalChat = false) {
  const scope = isGroup
    ? 'the current group'
    : (isPersonalChat ? 'this shared personal chat (both participants)' : 'the current user');
  const defaults = defaultSettings();
  const { supportedEfforts } = activeEffortPolicy();
  return makeTool({
    name: 'manage_preferences',
    description: `Change your own settings for ${scope} — the ones listed in CurrentSettings (voice, effort, language, custom memory). `
      + 'Pass only the fields to change; the others stay as they are. Values marked (default) there are the program defaults. '
      + 'Never store transient context (current task, session state, temporary data).',
    properties: {
      voice: {
        type: 'string',
        enum: VALID_VOICES,
        description: `Voice used for spoken replies (default ${defaults.voice}). `
          + `Male: ${VOICES_MALE.join(', ')}. Female: ${VOICES_FEMALE.join(', ')}. `
          + 'Pick the one matching the gender and character the user asks for.'
      },
      effort: {
        type: 'string',
        enum: supportedEfforts,
        description: `How much reasoning you spend per reply. Supported by the current main model: ${supportedEfforts.join(', ')}; `
          + `default ${defaults.effort}, the highest available. Lower is faster; higher is more thorough.`
      },
      language: {
        type: 'string',
        enum: VALID_LANGUAGES,
        description: `Language you reply and speak in (default ${defaults.language}). Main codes: it, en, es-ES, fr, de, pt-BR, zh, ja, ru, ar-SA.`
      },
      memory: {
        type: 'string',
        allowEmpty: true,
        description: 'Free-text custom instructions, for anything not covered by the fields above: '
          + 'e.g. speak with a certain slang, use lots of emoji, always prefer text or voice replies, or what the user is working on in this period '
          + '(ideas/projects that stay relevant for days, weeks or months — never a one-off question or transient context). '
          + 'Max 1000 chars, always in English; empty resets it to the default. Do not write timestamps: the system tracks them.'
      },
      replace: { type: 'boolean', description: 'Only affects `memory`: true (default) = rewrite it, false = append to the existing text.' }
    }
  });
}

const TOOL_TOGGLE_RELEASE_NOTIFY = makeTool({
  name: 'toggle_release_notify',
  description: 'Enable or disable new GemiX release notifications for this chat.',
  properties: { enabled: { type: 'boolean', description: 'true=enable, false=disable' } },
  required: ['enabled']
});

export {
  TOOL_TOGGLE_RELEASE_NOTIFY,
  buildManagePreferencesTool
};
