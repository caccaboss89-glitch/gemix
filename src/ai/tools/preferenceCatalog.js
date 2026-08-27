// src/ai/tools/preferenceCatalog.js
//
// Per-chat preferences and notification settings.

import {
  activeEffortPolicy,
  defaultSettings,
  VALID_LANGUAGES,
  VOICES_FEMALE,
  VOICES_MALE
} from '../../utils/settingsStore.js';
import { getActiveTtsCapabilities } from '../../media/ttsCapabilities.js';
import { makeTool } from './schema.js';

function buildManagePreferencesTool(isGroup, isPersonalChat = false) {
  const allowVoice = !isPersonalChat;
  const preferenceOptions = { allowVoice };
  const scope = isGroup
    ? 'the current group'
    : (isPersonalChat ? 'this shared personal chat (both participants)' : 'the current user');
  const defaults = defaultSettings(preferenceOptions);
  const { supportedEfforts } = activeEffortPolicy();
  const tts = getActiveTtsCapabilities();
  const properties = {};

  if (allowVoice && tts.selectableVoices) {
    properties.voice = {
      type: 'string',
      enum: tts.selectableVoices,
      description: `Voice used for spoken replies (default ${defaults.voice}). `
        + `Male: ${VOICES_MALE.join(', ')}. Female: ${VOICES_FEMALE.join(', ')}. `
        + 'Pick the one matching the gender and character the user asks for.'
    };
  }

  Object.assign(properties, {
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
      maxLength: 1000,
      description: 'Free-text custom instructions, for anything not covered by the fields above: '
        + `e.g. speak with a certain slang, use lots of emoji${allowVoice ? ', prefer text or spoken replies' : ''}, or what the user is working on in this period `
        + '(ideas/projects that stay relevant for days, weeks or months — never a one-off question or transient context). '
        + 'Max 1000 chars, always in English; empty resets it to the default. With `replace` false the new text is appended '
        + 'to the existing one on its own line; if the combined length would exceed 1000 chars the call is rejected outright, '
        + 'not truncated — shorten it or use `replace` true instead. Do not write timestamps: the system tracks them.'
    },
    replace: { type: 'boolean', description: 'Only affects `memory`: true (default) = rewrite it, false = append to the existing text.' }
  });

  const fieldNames = allowVoice && tts.selectableVoices
    ? 'voice, effort, language and custom memory'
    : 'effort, language and custom memory';
  return makeTool({
    name: 'manage_preferences',
    description: `Change your own settings for ${scope} — the ones listed in CurrentSettings (${fieldNames}). `
      + 'Pass only the fields to change; the others stay as they are. Values marked (default) there are the program defaults. '
      + 'A change takes effect from your next reply onward: it cannot alter the reasoning already under way for the current one. '
      + 'Never store transient context (current task, session state, temporary data).',
    properties
  });
}

const TOOL_TOGGLE_RELEASE_NOTIFY = makeTool({
  name: 'toggle_release_notify',
  description: 'Enable or disable new GemiX release notifications for this chat. Current state is shown in Runtime; call this only to change it.',
  properties: { enabled: { type: 'boolean', description: 'true=enable, false=disable' } },
  required: ['enabled']
});

export {
  TOOL_TOGGLE_RELEASE_NOTIFY,
  buildManagePreferencesTool
};
