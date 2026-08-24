// src/features/featureBindings.js
//
// Which backend implements each GemiX feature, for one provider profile.
//
// This is the layer that answers "who does the work", and it is deliberately
// separate from WireCapabilities, which only answers "can we talk to this
// endpoint". A provider advertising hosted web search changes nothing here: the
// binding is what the program routes on, and for search it is always GemiX
// for every profile.
//
// Some bindings are not negotiable. Web search, image search, page reading, the
// workspace, the filesystem, the shell and music generation belong to GemiX in
// every profile, so a profile cannot override them — the definition throws
// rather than letting a provider quietly take one over. Everything else has a
// GemiX-baseline default and a per-profile override.

/** Every feature a profile can bind. */
const FEATURE = Object.freeze({
  SEARCH_WEB: 'search_web',
  READ_PAGE: 'read_page',
  SEARCH_IMAGE: 'search_image',
  X_SEARCH: 'x_search',
  GENERATE_IMAGE: 'generate_image',
  GENERATE_VIDEO: 'generate_video',
  STT: 'stt',
  TTS: 'tts',
  WORKSPACE: 'workspace',
  FILESYSTEM: 'filesystem',
  SHELL: 'shell',
  MUSIC_GENERATION: 'music_generation'
});

/** The sentinel for a feature no backend implements on this profile. */
const UNAVAILABLE = 'unavailable';

/**
 * Features GemiX owns outright. A profile that tries to rebind one is a bug,
 * not a configuration choice: the whole point of the architecture is that the
 * provider never decides whether GemiX can search, read a file or run a shell.
 */
const GEMIX_OWNED = Object.freeze({
  [FEATURE.SEARCH_WEB]: 'gemix-web',
  [FEATURE.READ_PAGE]: 'gemix-web',
  [FEATURE.SEARCH_IMAGE]: 'gemix-image-search',
  [FEATURE.WORKSPACE]: 'gemix',
  [FEATURE.FILESYSTEM]: 'gemix',
  [FEATURE.SHELL]: 'gemix',
  // The music tool keeps its own OpenRouter/Lyria backend
  // whatever the main brain runs on.
  [FEATURE.MUSIC_GENERATION]: 'openrouter-lyria'
});

/**
 * Baselines for the features a profile may override. These are the answers for
 * a provider with no deliberately integrated media service of its own.
 */
const BASELINE = Object.freeze({
  [FEATURE.X_SEARCH]: UNAVAILABLE,
  [FEATURE.GENERATE_IMAGE]: 'cloudflare-flux',
  [FEATURE.GENERATE_VIDEO]: UNAVAILABLE,
  [FEATURE.STT]: 'cloudflare-whisper',
  [FEATURE.TTS]: 'google-translate'
});

/**
 * Fallback chains. A provider-primary backend degrades to the
 * GemiX baseline; a baseline backend has nowhere left to fall.
 */
const FALLBACKS = Object.freeze({
  'xai-imagine-image': 'cloudflare-flux',
  'xai-stt': 'cloudflare-whisper',
  'xai-tts': 'google-translate'
});

/**
 * Build the frozen binding map for a profile.
 *
 * @param {object} overrides - feature -> backend id, for overridable features only
 * @returns {Readonly<Record<string, string>>}
 */
function defineFeatureBindings(overrides = {}) {
  const out = { ...GEMIX_OWNED, ...BASELINE };
  for (const [feature, backend] of Object.entries(overrides)) {
    if (!Object.values(FEATURE).includes(feature)) {
      throw new Error(`Unknown feature "${feature}". Add it to FEATURE first.`);
    }
    if (feature in GEMIX_OWNED) {
      throw new Error(`Feature "${feature}" is GemiX-owned and cannot be bound to a provider backend.`);
    }
    out[feature] = backend;
  }
  return Object.freeze(out);
}

/**
 * The backend bound to a feature on this profile.
 * @param {object} profile
 * @param {string} feature
 * @returns {string}
 */
function backendFor(profile, feature) {
  return profile?.features?.[feature] ?? UNAVAILABLE;
}

/** True when the profile has a backend for this feature. */
function isFeatureAvailable(profile, feature) {
  return backendFor(profile, feature) !== UNAVAILABLE;
}

/**
 * The backend to try when the primary one is unusable, or null when the primary
 * is already the last resort.
 * @param {string} backend
 * @returns {string|null}
 */
function fallbackBackendFor(backend) {
  return FALLBACKS[backend] || null;
}

export {
  FEATURE,
  UNAVAILABLE,
  defineFeatureBindings,
  backendFor,
  isFeatureAvailable,
  fallbackBackendFor
};
