// src/ai/providers/providerProfile.js
//
// A ProviderProfile is a preset, not an implementation. It says which model,
// which turn runtime, which endpoint, which credential source, which transport
// extension and which backend implements each provider-dependent media feature —
// and nothing else. Every module that needs one of those answers reads it here
// instead of re-deriving it from a model slug, a base URL or the contents of an
// auth file.
//
// Fields every runtime reads sit at the top level; what only one runtime needs
// sits in that runtime's own block, so the separation is visible in the shape:
//
//   profile.runtime      -> which turn engine drives the conversation
//   profile.responses    -> Responses runtime only:
//     .wire                     WireCapabilities: can we talk to this endpoint at all
//     .createCredentialProvider how a request is authenticated
//     .extensions               provider-specific Responses behaviour, behind a boundary
//   profile.claudeAgent  -> Claude Agent runtime only: subscription token,
//                           Claude Code directories, concurrency
//   profile.features     -> runtime-routed image/video/STT backends
//
// The provider is resolved once, at startup, from AI_PROVIDER. It can never
// change mid-turn. Fixed GemiX tools such as file access, shell and web search
// are deliberately absent from the provider profile.

import constants from '../../config/constants.js';
import envConfig from '../../config/env.js';
import { defineWireCapabilities, validateWireCapabilities } from './wireCapabilities.js';
import { FEATURE, defineFeatureBindings } from '../../features/featureBindings.js';
import { ApiKeyCredentialProvider } from '../credentials/credentialProvider.js';
import { sharedCredentialProvider, xaiCredentialProvider } from '../credentials/credentialRegistry.js';
import { createCodexCredentialProvider } from '../credentials/nativeCodexCredentialProvider.js';
import { CREDENTIAL_POOL } from '../credentials/oauthProviders.js';
import {
  XAI_X_SEARCH_TOOL,
  xaiResponsesExtensions
} from '../extensions/xaiResponsesExtensions.js';

const PROVIDER = Object.freeze({
  XAI: 'xai',
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude',
  OPENROUTER: 'openrouter',
  CUSTOM: 'custom'
});

/** The turn engines a profile can name; each reads only its own profile block. */
const RUNTIME = Object.freeze({
  RESPONSES: 'responses',
  CLAUDE_AGENT: 'claude-agent'
});

const PROMPT_VARIANT = Object.freeze({
  GENERIC: 'generic',
  XAI: 'xai',
  CLAUDE: 'claude'
});

const NO_NATIVE_TOOLS = Object.freeze([]);

/** Ordered reasoning-effort scale the xAI Responses API accepts. */
const XAI_EFFORTS = Object.freeze(['low', 'medium', 'high']);
/** GPT-5.6 Responses scale, including the supported non-reasoning mode. */
const GPT_56_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
/** Ordered generic Responses scale: the three efforts the API documents. */
const GENERIC_EFFORTS = Object.freeze(['low', 'medium', 'high']);
/** Ordered Claude Agent scale, as the Agent SDK's `effort` option takes it. */
const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

function _chatgptEfforts(model) {
  return /^gpt-5\.6(?:-|$)/i.test(String(model || '')) ? GPT_56_EFFORTS : GENERIC_EFFORTS;
}

/** Display brand for footers, badges and the prompt opening. */
function _xaiDisplayName(model) {
  const slug = String(model || '').split('/').pop().split(':')[0];
  const grok = slug.match(/^grok-(\d+(?:\.\d+)?)(?:-|$)/);
  if (grok) return `Grok ${grok[1]}`;
  if (!slug) return 'AI Model';
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Release number plus the variant name the slug carries: gpt-5.6-sol -> ChatGPT 5.6 Sol. */
function _chatgptDisplayName(model) {
  const slug = String(model || '').trim();
  const gpt = slug.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.*))?$/i);
  if (gpt) {
    const variant = (gpt[2] || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
    return variant ? `ChatGPT ${gpt[1]} ${variant}` : `ChatGPT ${gpt[1]}`;
  }
  return slug ? `ChatGPT (${slug})` : 'ChatGPT';
}

/** Family plus version: claude-sonnet-5-5 -> Claude Sonnet 5.5. */
function _claudeDisplayName(model) {
  const slug = String(model || '').trim();
  const claude = slug.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1).toLowerCase();
    return `Claude ${family} ${claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]}`;
  }
  return slug ? `Claude (${slug})` : 'Claude';
}

function _genericDisplayName(model) {
  const slug = String(model || '').split('/').pop().split(':')[0];
  if (!slug) return 'AI Model';
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Format a model name according to the selected provider's public brand. */
function formatProviderModelDisplayName(providerId, model) {
  if (providerId === PROVIDER.XAI) return _xaiDisplayName(model);
  if (providerId === PROVIDER.CHATGPT) return _chatgptDisplayName(model);
  if (providerId === PROVIDER.CLAUDE) return _claudeDisplayName(model);
  return _genericDisplayName(model);
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
    runtime: RUNTIME.RESPONSES,
    model: envConfig.GROK_MODEL,
    displayName: formatProviderModelDisplayName(PROVIDER.XAI, envConfig.GROK_MODEL),
    defaultEffort: 'medium',
    supportedEfforts: XAI_EFFORTS,
    promptVariant: PROMPT_VARIANT.XAI,
    nativeTools: Object.freeze([XAI_X_SEARCH_TOOL]),
    features: defineFeatureBindings({
      [FEATURE.GENERATE_IMAGE]: 'xai-imagine-image',
      [FEATURE.GENERATE_VIDEO]: 'xai-imagine-video',
      [FEATURE.STT]: 'xai-stt'
    }),
    responses: {
      baseUrl: envConfig.XAI_BASE_URL,
      wire: defineWireCapabilities({
        supportsResponses: true,
        supportsSse: true,
        supportsFunctionCalling: true,
        supportsStrictStructuredOutput: true,
        supportsReasoningReplay: true,
        supportsImageInput: true,
        supportsMaxOutputTokens: true,
        supportsPromptCacheKey: true
      }),
      createCredentialProvider: xaiCredentialProvider,
      extensions: xaiResponsesExtensions
    }
  };
}

/**
 * The ChatGPT subscription reached through the Codex backend. It is treated as
 * exactly what the credential unlocks — a Responses endpoint — and never as the
 * whole OpenAI product line: image, video and STT fall back to the GemiX
 * baselines.
 *
 * `supportsMaxOutputTokens` is deliberately absent: this backend answers
 * `HTTP 400 UNSUPPORTED_INPUT: Unsupported parameter: max_output_tokens` and
 * fails the entire request. The length of the answer is left to the endpoint.
 *
 * `xhigh` and `max` remain selectable per chat, but they cost enough latency to
 * be a deliberate choice rather than where every conversation starts.
 */
function _buildChatgptProfile() {
  return {
    id: PROVIDER.CHATGPT,
    runtime: RUNTIME.RESPONSES,
    model: envConfig.CHATGPT_MODEL,
    displayName: formatProviderModelDisplayName(PROVIDER.CHATGPT, envConfig.CHATGPT_MODEL),
    defaultEffort: 'medium',
    supportedEfforts: _chatgptEfforts(envConfig.CHATGPT_MODEL),
    promptVariant: PROMPT_VARIANT.GENERIC,
    nativeTools: NO_NATIVE_TOOLS,
    features: defineFeatureBindings({}),
    responses: {
      baseUrl: envConfig.CHATGPT_BASE_URL,
      wire: defineWireCapabilities({
        supportsResponses: true,
        supportsSse: true,
        supportsFunctionCalling: true,
        supportsStrictStructuredOutput: true,
        supportsReasoningReplay: true,
        supportsImageInput: true,
        // Verified by the live Codex backend. Other generic endpoints do not
        // inherit this optional field merely for being Responses-compatible.
        supportsPromptCacheKey: true
      }),
      createCredentialProvider: () => sharedCredentialProvider(
        CREDENTIAL_POOL.CHATGPT,
        () => createCodexCredentialProvider()
      ),
      // Nothing about this backend needs a Responses extension: no extra header
      // beyond the account id the credential already carries, no extra body field.
      extensions: null
    }
  };
}

/**
 * Claude on the admin's subscription, driven through the Claude Agent SDK: the
 * Claude Code process runs the model/tool loop while every tool stays a GemiX
 * tool. No provider-hosted tool or media service is used, so the feature
 * bindings are the GemiX baselines.
 *
 * `medium` is the default because it answers chat turns about as fast as `low`
 * while still checking facts with tools; higher levels stay a per-chat choice.
 */
function _buildClaudeProfile() {
  return {
    id: PROVIDER.CLAUDE,
    runtime: RUNTIME.CLAUDE_AGENT,
    model: envConfig.CLAUDE_MODEL,
    displayName: formatProviderModelDisplayName(PROVIDER.CLAUDE, envConfig.CLAUDE_MODEL),
    defaultEffort: 'medium',
    supportedEfforts: CLAUDE_EFFORTS,
    promptVariant: PROMPT_VARIANT.CLAUDE,
    nativeTools: NO_NATIVE_TOOLS,
    features: defineFeatureBindings({}),
    claudeAgent: {
      oauthToken: envConfig.CLAUDE_CODE_OAUTH_TOKEN,
      configDir: constants.CLAUDE_CODE_CONFIG_DIR,
      workDir: constants.CLAUDE_CODE_WORK_DIR,
      maxConcurrentTurns: envConfig.CLAUDE_MAX_CONCURRENT_TURNS
    }
  };
}

/**
 * OpenRouter as the main brain. Accessory services of the provider are NOT
 * discovered or integrated: only the model is used from here.
 */
function _buildOpenRouterProfile() {
  return {
    id: PROVIDER.OPENROUTER,
    runtime: RUNTIME.RESPONSES,
    model: envConfig.OPENROUTER_MAIN_MODEL,
    displayName: formatProviderModelDisplayName(PROVIDER.OPENROUTER, envConfig.OPENROUTER_MAIN_MODEL),
    defaultEffort: 'medium',
    supportedEfforts: GENERIC_EFFORTS,
    promptVariant: PROMPT_VARIANT.GENERIC,
    nativeTools: NO_NATIVE_TOOLS,
    features: defineFeatureBindings({}),
    responses: {
      baseUrl: envConfig.OPENROUTER_BASE_URL,
      wire: defineWireCapabilities({
        supportsResponses: true,
        supportsSse: true,
        supportsFunctionCalling: true,
        supportsStrictStructuredOutput: true,
        supportsReasoningReplay: true,
        supportsImageInput: true
      }),
      createCredentialProvider: () => sharedCredentialProvider(
        'openrouter-api-key',
        () => new ApiKeyCredentialProvider({
          id: 'openrouter-api-key',
          apiKey: envConfig.OPENROUTER_API_KEY,
          baseUrl: envConfig.OPENROUTER_BASE_URL,
          headers: { 'HTTP-Referer': envConfig.OPENROUTER_HTTP_REFERER }
        })
      ),
      extensions: null
    }
  };
}

/** Any other Responses-compatible endpoint, configured entirely from .env. */
function _buildCustomProfile() {
  return {
    id: PROVIDER.CUSTOM,
    runtime: RUNTIME.RESPONSES,
    model: envConfig.CUSTOM_RESPONSES_MODEL,
    displayName: formatProviderModelDisplayName(PROVIDER.CUSTOM, envConfig.CUSTOM_RESPONSES_MODEL),
    defaultEffort: 'medium',
    supportedEfforts: GENERIC_EFFORTS,
    promptVariant: PROMPT_VARIANT.GENERIC,
    nativeTools: NO_NATIVE_TOOLS,
    features: defineFeatureBindings({}),
    responses: {
      baseUrl: envConfig.CUSTOM_RESPONSES_BASE_URL,
      wire: defineWireCapabilities({
        supportsResponses: true,
        supportsSse: true,
        supportsFunctionCalling: true,
        supportsStrictStructuredOutput: true,
        supportsReasoningReplay: true,
        supportsImageInput: true
      }),
      createCredentialProvider: () => sharedCredentialProvider(
        'custom-api-key',
        () => new ApiKeyCredentialProvider({
          id: 'custom-api-key',
          apiKey: envConfig.CUSTOM_RESPONSES_API_KEY,
          baseUrl: envConfig.CUSTOM_RESPONSES_BASE_URL
        })
      ),
      extensions: null
    }
  };
}

const BUILDERS = Object.freeze({
  [PROVIDER.XAI]: _buildXaiProfile,
  [PROVIDER.CHATGPT]: _buildChatgptProfile,
  [PROVIDER.CLAUDE]: _buildClaudeProfile,
  [PROVIDER.OPENROUTER]: _buildOpenRouterProfile,
  [PROVIDER.CUSTOM]: _buildCustomProfile
});

const PROVIDER_IDS = Object.freeze(Object.keys(BUILDERS));

/**
 * What each runtime requires of a profile: the block it reads and the reasons
 * that block cannot drive the main brain (none when it can).
 */
const RUNTIME_CONTRACTS = Object.freeze({
  [RUNTIME.RESPONSES]: Object.freeze({
    block: 'responses',
    problems(block) {
      const check = validateWireCapabilities(block.wire);
      return check.ok ? [] : [`missing wire capabilities ${check.missing.join(', ')}`];
    }
  }),
  [RUNTIME.CLAUDE_AGENT]: Object.freeze({
    block: 'claudeAgent',
    problems(block) {
      const problems = [];
      if (!String(block.oauthToken || '').trim()) problems.push('no subscription token');
      if (!block.configDir || !block.workDir) problems.push('no Claude Code directories');
      if (!Number.isInteger(block.maxConcurrentTurns) || block.maxConcurrentTurns < 1) {
        problems.push('no concurrent-turn limit');
      }
      return problems;
    }
  })
});

let _active = null;

/**
 * The immutable profile for a provider id, refused unless it meets the
 * contract of the runtime it names.
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
  const contract = RUNTIME_CONTRACTS[profile.runtime];
  if (!contract) {
    throw new Error(`Provider "${id}" names an unknown runtime "${profile.runtime}".`);
  }
  const block = profile[contract.block];
  const problems = block ? contract.problems(block) : [`no "${contract.block}" block`];
  if (problems.length > 0) {
    throw new Error(`Provider "${id}" cannot drive the GemiX main brain: ${problems.join('; ')}.`);
  }
  return Object.freeze({ ...profile, [contract.block]: Object.freeze(block) });
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

/** Reset the memoized profile. Tests only — a live process resolves once. */
function _resetActiveProfileForTests() {
  _active = null;
}

export {
  PROVIDER,
  PROMPT_VARIANT,
  RUNTIME,
  formatProviderModelDisplayName,
  getProviderProfile,
  resolveProviderProfile,
  _resetActiveProfileForTests
};
