// src/ai/providers/providerProfile.js
//
// A ProviderProfile is a preset, not an implementation. It says which model,
// which endpoint, which credential source, which transport extension and which
// backend implements each GemiX feature — and nothing else. Every module that
// needs one of those answers reads it here instead of re-deriving it from a
// model slug, a base URL or the contents of an auth file.
//
// The separation the spec insists on (§3) is visible in the shape:
//
//   profile.wire        -> WireCapabilities: can we talk to this endpoint at all
//   profile.credentials -> CredentialProvider: how a request is authenticated
//   profile.extensions  -> provider-specific Responses behaviour, behind a boundary
//   profile.features    -> which backend implements each GemiX feature
//
// The provider is resolved once, at startup, from AI_PROVIDER. It can never
// change mid-turn, and it never decides whether GemiX can read a file, run a
// shell or search the web — those are feature bindings, and they are GemiX's.

import envConfig from '../../config/env.js';
import { defineWireCapabilities, validateWireCapabilities } from './wireCapabilities.js';
import { FEATURE, defineFeatureBindings } from '../../features/featureBindings.js';
import { ApiKeyCredentialProvider } from '../credentials/credentialProvider.js';
import { XaiAuthFileCredentialProvider } from '../credentials/xaiAuthFileCredentialProvider.js';
import { xaiResponsesExtensions } from '../extensions/xaiResponsesExtensions.js';

const PROVIDER = Object.freeze({
  XAI: 'xai',
  OPENROUTER: 'openrouter',
  CUSTOM: 'custom'
});

/** Reasoning efforts the xAI Responses API accepts. */
const XAI_EFFORTS = Object.freeze(['low', 'medium', 'high']);
/** Generic Responses providers: the three the API documents. */
const GENERIC_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/** Display brand for footers, badges and the prompt opening. */
function _xaiDisplayName(model) {
  const slug = String(model || '').split('/').pop().split(':')[0];
  const grok = slug.match(/^grok-(\d+(?:\.\d+)?)(?:-|$)/);
  if (grok) return `Grok ${grok[1]}`;
  if (!slug) return 'AI Model';
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _genericDisplayName(model) {
  const slug = String(model || '').split('/').pop().split(':')[0];
  if (!slug) return 'AI Model';
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// -- Profile builders --------------------------------------------------------

/**
 * xAI, reachable through its OpenAI-Responses-compatible endpoint. The only
 * profile with provider-side media services GemiX deliberately integrates, so
 * the only one whose feature bindings name a non-GemiX backend as primary.
 */
function _buildXaiProfile() {
  return {
    id: PROVIDER.XAI,
    model: envConfig.GROK_MODEL,
    displayName: _xaiDisplayName(envConfig.GROK_MODEL),
    identity: 'SuperGrok',
    baseUrl: envConfig.XAI_BASE_URL,
    defaultEffort: 'high',
    supportedEfforts: XAI_EFFORTS,
    wire: defineWireCapabilities({
      supportsResponses: true,
      supportsSse: true,
      supportsFunctionCalling: true,
      supportsStrictStructuredOutput: true,
      supportsReasoningReplay: true,
      supportsImageInput: true
    }),
    createCredentialProvider: () => (envConfig.XAI_USE_API_KEY
      ? new ApiKeyCredentialProvider({
        id: 'xai-api-key',
        apiKey: envConfig.XAI_API_KEY,
        baseUrl: envConfig.XAI_BASE_URL
      })
      : new XaiAuthFileCredentialProvider()),
    extensions: xaiResponsesExtensions,
    features: defineFeatureBindings({
      [FEATURE.X_SEARCH]: 'xai-native',
      [FEATURE.GENERATE_IMAGE]: 'xai-imagine-image',
      [FEATURE.GENERATE_VIDEO]: 'xai-imagine-video',
      [FEATURE.STT]: 'xai-stt',
      [FEATURE.TTS]: 'xai-tts'
    })
  };
}

/**
 * OpenRouter as the main brain. Accessory services of the provider are NOT
 * discovered or integrated (spec §3.4): only the model is used from here.
 */
function _buildOpenRouterProfile() {
  return {
    id: PROVIDER.OPENROUTER,
    model: envConfig.OPENROUTER_MAIN_MODEL,
    displayName: _genericDisplayName(envConfig.OPENROUTER_MAIN_MODEL),
    identity: 'GemiX',
    baseUrl: envConfig.OPENROUTER_BASE_URL,
    defaultEffort: 'high',
    supportedEfforts: GENERIC_EFFORTS,
    wire: defineWireCapabilities({
      supportsResponses: true,
      supportsSse: true,
      supportsFunctionCalling: true,
      supportsStrictStructuredOutput: true,
      supportsReasoningReplay: true,
      supportsImageInput: true
    }),
    createCredentialProvider: () => new ApiKeyCredentialProvider({
      id: 'openrouter-api-key',
      apiKey: envConfig.OPENROUTER_API_KEY,
      baseUrl: envConfig.OPENROUTER_BASE_URL,
      headers: { 'HTTP-Referer': envConfig.OPENROUTER_HTTP_REFERER }
    }),
    extensions: null,
    features: defineFeatureBindings({})
  };
}

/** Any other Responses-compatible endpoint, configured entirely from .env. */
function _buildCustomProfile() {
  return {
    id: PROVIDER.CUSTOM,
    model: envConfig.CUSTOM_RESPONSES_MODEL,
    displayName: _genericDisplayName(envConfig.CUSTOM_RESPONSES_MODEL),
    identity: 'GemiX',
    baseUrl: envConfig.CUSTOM_RESPONSES_BASE_URL,
    defaultEffort: 'high',
    supportedEfforts: GENERIC_EFFORTS,
    wire: defineWireCapabilities({
      supportsResponses: true,
      supportsSse: true,
      supportsFunctionCalling: true,
      supportsStrictStructuredOutput: true,
      supportsReasoningReplay: true,
      supportsImageInput: true
    }),
    createCredentialProvider: () => new ApiKeyCredentialProvider({
      id: 'custom-api-key',
      apiKey: envConfig.CUSTOM_RESPONSES_API_KEY,
      baseUrl: envConfig.CUSTOM_RESPONSES_BASE_URL
    }),
    extensions: null,
    features: defineFeatureBindings({})
  };
}

const BUILDERS = Object.freeze({
  [PROVIDER.XAI]: _buildXaiProfile,
  [PROVIDER.OPENROUTER]: _buildOpenRouterProfile,
  [PROVIDER.CUSTOM]: _buildCustomProfile
});

const PROVIDER_IDS = Object.freeze(Object.keys(BUILDERS));

let _active = null;

/**
 * The immutable profile for a provider id.
 * @param {string} [providerId]
 * @returns {Readonly<object>}
 */
function getProviderProfile(providerId = envConfig.AI_PROVIDER) {
  const id = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  const builder = BUILDERS[id];
  if (!builder) {
    throw new Error(`Unknown AI provider "${providerId}". Allowed: ${PROVIDER_IDS.join(', ')}.`);
  }
  const profile = builder();
  const check = validateWireCapabilities(profile.wire);
  if (!check.ok) {
    throw new Error(
      `Provider "${id}" does not meet the GemiX wire contract (missing: ${check.missing.join(', ')}).`
    );
  }
  return Object.freeze(profile);
}

/**
 * The profile this process runs on, resolved once so a provider can never
 * change mid-request.
 * @returns {Readonly<object>}
 */
function resolveProviderProfile() {
  if (!_active) _active = getProviderProfile(envConfig.AI_PROVIDER);
  return _active;
}

/**
 * Read the profile off any context that carries one, falling back to the active
 * profile. Contexts are threaded explicitly (ctx → userCtx → callOpts); this is
 * the single accessor, so no module invents its own guess.
 * @param {object} [ctx]
 * @returns {Readonly<object>}
 */
function profileFromContext(ctx) {
  if (ctx && typeof ctx === 'object') {
    // A profile handed straight in (dump generator, tests): without this a
    // caller that already resolved one would silently fall through to the
    // active profile whenever the two differ.
    if (typeof ctx.id === 'string' && ctx.wire && BUILDERS[ctx.id]) return ctx;
    if (ctx.providerProfile && typeof ctx.providerProfile === 'object') return ctx.providerProfile;
    if (typeof ctx.providerId === 'string' && ctx.providerId) return getProviderProfile(ctx.providerId);
  }
  return resolveProviderProfile();
}

/** Reset the memoized profile. Tests only — a live process resolves once. */
function _resetActiveProfileForTests() {
  _active = null;
}

export {
  PROVIDER,
  PROVIDER_IDS,
  XAI_EFFORTS,
  GENERIC_EFFORTS,
  getProviderProfile,
  resolveProviderProfile,
  profileFromContext,
  _resetActiveProfileForTests
};
