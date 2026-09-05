// src/features/featureBindings.js
//
// Provider-dependent backend bindings. Only capabilities that runtime dispatch
// actually resolves belong here; fixed GemiX tools do not need descriptive
// entries in every provider profile.

/** Every feature a profile can bind. */
const FEATURE = Object.freeze({
  GENERATE_IMAGE: 'generate_image',
  GENERATE_VIDEO: 'generate_video',
  STT: 'stt'
});

/** The sentinel for a feature no backend implements on this profile. */
const UNAVAILABLE = 'unavailable';

/**
 * Baselines for the features a profile may override. These are the answers for
 * a provider with no deliberately integrated media service of its own.
 */
const BASELINE = Object.freeze({
  [FEATURE.GENERATE_IMAGE]: 'cloudflare-flux',
  [FEATURE.GENERATE_VIDEO]: UNAVAILABLE,
  [FEATURE.STT]: 'cloudflare-whisper'
});

/**
 * Fallback chains. A provider-primary backend degrades to the
 * GemiX baseline; a baseline backend has nowhere left to fall.
 */
const FALLBACKS = Object.freeze({
  'xai-imagine-image': 'cloudflare-flux',
  'xai-stt': 'cloudflare-whisper'
});

/**
 * Build the frozen binding map for a profile.
 *
 * @param {object} overrides - feature -> backend id, for overridable features only
 * @returns {Readonly<Record<string, string>>}
 */
function defineFeatureBindings(overrides = {}) {
  const out = { ...BASELINE };
  for (const [feature, backend] of Object.entries(overrides)) {
    if (!Object.values(FEATURE).includes(feature)) {
      throw new Error(`Unknown feature "${feature}". Add it to FEATURE first.`);
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
