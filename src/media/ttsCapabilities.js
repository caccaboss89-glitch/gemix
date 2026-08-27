// Effective TTS behavior exposed to the model. A provider binding is only a
// candidate: when the xAI TTS switch is off, Google is the actual backend and
// xAI voice names or expressive tags must stay invisible.

import envConfig from '../config/env.js';
import { FEATURE, backendFor } from '../features/featureBindings.js';
import { resolveProviderProfile } from '../ai/providers/providerProfile.js';

const TTS_BACKEND = Object.freeze({
  GOOGLE: 'google-translate',
  XAI: 'xai-tts'
});

const XAI_VOICES_FEMALE = Object.freeze([
  'eve', 'ara', 'carina', 'luna', 'iris', 'altair', 'celeste', 'ursa', 'lumen'
]);
const XAI_VOICES_MALE = Object.freeze([
  'leo', 'rex', 'zagan', 'helix', 'orion', 'perseus', 'helios', 'lux', 'kepler', 'rigel',
  'cosmo', 'sirius', 'castor', 'naksh', 'atlas'
]);
const XAI_VOICES = Object.freeze([...XAI_VOICES_MALE, ...XAI_VOICES_FEMALE]);

const GOOGLE_CAPABILITIES = Object.freeze({
  backend: TTS_BACKEND.GOOGLE,
  selectableVoices: null,
  supportsVoiceTags: false
});

const XAI_CAPABILITIES = Object.freeze({
  backend: TTS_BACKEND.XAI,
  selectableVoices: XAI_VOICES,
  supportsVoiceTags: true
});

function getActiveTtsCapabilities(profile = resolveProviderProfile()) {
  const bound = backendFor(profile, FEATURE.TTS);
  return bound === TTS_BACKEND.XAI && envConfig.XAI_TTS_ENABLED
    ? XAI_CAPABILITIES
    : GOOGLE_CAPABILITIES;
}

export {
  TTS_BACKEND,
  XAI_VOICES,
  XAI_VOICES_FEMALE,
  XAI_VOICES_MALE,
  getActiveTtsCapabilities
};
