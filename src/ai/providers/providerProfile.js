// src/ai/providers/providerProfile.js
//
// The provider is resolved once, at startup, from AI_PROVIDER — never from a
// model slug, a base URL, the presence of a tool or the contents of auth.json.
// resolveProviderProfile() returns a frozen ProviderProfile that every layer
// reads instead of re-deriving the answer: prompt, tool registry, response
// schema, attachment projection, dispatcher, quotas, media, Build runner,
// errors and dumps all key off this one object.
//
// The profile carries identity and policy, not behaviour: the modules that do
// the work (transport, projector, runner, image generator, voice) are named
// here and imported by their callers, so this file stays free of cycles and
// can be read as the contract between the two branches.

import envConfig from '../../config/env.js';

const PROVIDER = {
  XAI: 'xai',
  OPENAI: 'openai'
};

/** Reasoning efforts the xAI Responses API accepts for the main brain. */
const XAI_EFFORTS = ['low', 'medium', 'high'];
/** Efforts the Codex model catalog reports for gpt-5.6-sol. */
const OPENAI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * Capability flags a provider can offer. The effective set for a turn is this
 * intersected with the platform/membership matrix (see capabilityMatrix.js).
 */
function _xaiCapabilities() {
  return {
    webSearch: true,
    xSearch: true,
    imageSearch: true,
    hostedImageResults: false,
    // X media URLs come back inside a hosted search whose results GemiX never
    // sees, so there is nothing to build an allowlist from.
    imageAllowlist: false,
    readVideo: true,
    generateImage: true,
    generateVideo: true,
    build: true,
    voiceReply: true,
    namedVoices: true,
    userVoiceTranscription: false,
    inlineCitations: true,
    nativeAudioInput: true,
    nativeVideoInput: true
  };
}

function _openaiCapabilities() {
  return {
    webSearch: true,
    // Probed and rejected on the Codex OAuth path: there is no X corpus here.
    xSearch: false,
    imageSearch: true,
    // Structured `image_result` entries come back on the hosted web_search call.
    hostedImageResults: true,
    // Every deliverable image is therefore one this turn's structured results
    // named, or one the user wrote themselves.
    imageAllowlist: true,
    readVideo: false,
    generateImage: true,
    generateVideo: false,
    // Codex Build stays off until the host-side auth broker has been verified
    // on the VPS: without that boundary the CLI's own shell could read the
    // bearer, and copying the token into the sandbox is not an option.
    build: envConfig.CODEX_BUILD_ENABLED,
    voiceReply: true,
    // Google Translate TTS has no voice catalog, so no voice preference exists.
    namedVoices: false,
    // GPT-5.6 Sol rejects raw audio, so user voice notes arrive transcribed.
    userVoiceTranscription: true,
    inlineCitations: true,
    nativeAudioInput: false,
    nativeVideoInput: false
  };
}

/** Human-readable brand shown in footers, badges and the prompt opening. */
function _openaiDisplayName(model) {
  const slug = String(model || '').trim();
  const sol = slug.match(/^gpt-(\d+(?:\.\d+)?)-sol\b/i);
  if (sol) return `ChatGPT ${sol[1]} Sol`;
  const gpt = slug.match(/^gpt-(\d+(?:\.\d+)?)\b/i);
  if (gpt) return `ChatGPT ${gpt[1]}`;
  return slug ? `ChatGPT (${slug})` : 'ChatGPT';
}

/** Same rule the xAI branch has always used for the model display name. */
function _xaiDisplayName(model) {
  const slug = String(model || '').split('/').pop().split(':')[0];
  const grok = slug.match(/^grok-(\d+(?:\.\d+)?)(?:-|$)/);
  if (grok) return `Grok ${grok[1]}`;
  if (!slug) return 'AI Model';
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _buildXaiProfile() {
  return {
    id: PROVIDER.XAI,
    model: envConfig.GROK_MODEL,
    displayName: _xaiDisplayName(envConfig.GROK_MODEL),
    // Written in the prompt opening; the fusion line is part of GemiX's identity.
    identity: 'SuperGrok',
    defaultEffort: 'high',
    supportedEfforts: Object.freeze([...XAI_EFFORTS]),
    capabilities: Object.freeze(_xaiCapabilities()),
    transport: 'xai-responses',
    auth: Object.freeze({
      kind: envConfig.XAI_USE_API_KEY ? 'api-key' : 'hermes-oauth',
      hermesPool: 'xai-oauth',
      authFile: envConfig.XAI_AUTH_FILE,
      refreshProvider: envConfig.HERMES_REFRESH_PROVIDER
    }),
    preflight: 'xai-models',
    attachmentProjection: 'xai',
    toolResultProjection: 'xai',
    buildRunner: 'grok',
    imageGenerator: 'grok-imagine',
    voiceProfile: Object.freeze({
      backend: 'xai-tts',
      label: envConfig.XAI_TTS_VOICE,
      supportsVoiceTags: true,
      attribution: null
    }),
    errorPolicy: 'xai',
    searchStatsExtractor: 'xai'
  };
}

function _buildOpenaiProfile() {
  return {
    id: PROVIDER.OPENAI,
    model: envConfig.OPENAI_MODEL,
    displayName: _openaiDisplayName(envConfig.OPENAI_MODEL),
    identity: 'ChatGPT',
    defaultEffort: OPENAI_EFFORTS.includes(envConfig.OPENAI_REASONING_EFFORT)
      ? envConfig.OPENAI_REASONING_EFFORT
      : 'max',
    supportedEfforts: Object.freeze([...OPENAI_EFFORTS]),
    capabilities: Object.freeze(_openaiCapabilities()),
    transport: 'openai-codex-responses',
    auth: Object.freeze({
      kind: 'hermes-oauth',
      hermesPool: 'openai-codex',
      authFile: envConfig.OPENAI_AUTH_FILE,
      refreshProvider: envConfig.OPENAI_HERMES_REFRESH_PROVIDER
    }),
    preflight: 'openai-credentials',
    attachmentProjection: 'openai',
    toolResultProjection: 'openai',
    buildRunner: 'codex',
    imageGenerator: 'gpt-image',
    voiceProfile: Object.freeze({
      backend: 'google-translate',
      label: 'Google Translate',
      supportsVoiceTags: false,
      attribution: 'Google Translate (powered by Google)'
    }),
    errorPolicy: 'openai',
    searchStatsExtractor: 'openai'
  };
}

const BUILDERS = {
  [PROVIDER.XAI]: _buildXaiProfile,
  [PROVIDER.OPENAI]: _buildOpenaiProfile
};

let _active = null;

/**
 * The immutable profile for a provider id. Defaults to the configured
 * AI_PROVIDER, which is what every caller in a live turn passes through.
 * @param {string} [providerId]
 * @returns {object} frozen ProviderProfile
 */
function getProviderProfile(providerId = envConfig.AI_PROVIDER) {
  const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const builder = BUILDERS[id];
  if (!builder) {
    throw new Error(`Unknown AI provider "${providerId}". Allowed: ${envConfig.AI_PROVIDERS.join(', ')}.`);
  }
  return Object.freeze(builder());
}

/**
 * The profile this process runs on, resolved once and reused for every turn so
 * a provider can never change mid-request.
 * @returns {object} frozen ProviderProfile
 */
function resolveProviderProfile() {
  if (!_active) _active = getProviderProfile(envConfig.AI_PROVIDER);
  return _active;
}

/**
 * Read the profile off any context object that carries one, falling back to the
 * active profile. Contexts are threaded explicitly (ctx → userCtx → responseCtx
 * → callOpts); this is the single accessor so no module invents its own guess.
 * @param {object} [ctx]
 * @returns {object} frozen ProviderProfile
 */
function profileFromContext(ctx) {
  if (ctx && typeof ctx === 'object') {
    if (ctx.providerProfile && typeof ctx.providerProfile === 'object') return ctx.providerProfile;
    if (typeof ctx.providerId === 'string' && ctx.providerId) return getProviderProfile(ctx.providerId);
  }
  return resolveProviderProfile();
}

/** True when the context runs on the OpenAI profile. */
function isOpenAI(ctx) {
  return profileFromContext(ctx).id === PROVIDER.OPENAI;
}

export {
  PROVIDER,
  XAI_EFFORTS,
  OPENAI_EFFORTS,
  getProviderProfile,
  resolveProviderProfile,
  profileFromContext,
  isOpenAI
};
