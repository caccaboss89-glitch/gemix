// src/ai/providers/preflight.js
//
// The startup check for the profile this process runs on, dispatched on the
// runtime the profile names.
//
// For the Responses runtime two things are checked, in this order:
//   1. the profile declaration — a profile that does not declare every required
//      Responses/SSE/function/schema/replay/vision capability is refused;
//   2. the credential — resolved once so a misconfiguration surfaces at boot
//      instead of on the first user message.
//
// The credential half is deliberately soft: a token that is missing at boot may
// well be there by the first message, and taking the bot off every platform for
// it would be worse than a warning. The wire half is hard, because it is a
// configuration error that cannot fix itself.
//
// For the Claude Agent runtime, Claude Code is started once without a message:
// a missing binary, or a credential other than the subscription token, is
// refused, because the second would bill turns to the pay-per-use API. A probe
// that cannot start, or a configured model Claude Code does not list, is only
// a warning: every turn still checks its own credential.

import pkg from '../../../package.json' with { type: 'json' };
import { createLogger } from '../../utils/logger.js';
import { getCredentialProvider } from '../aiProvider.js';
import {
  SUBSCRIPTION_TOKEN_SOURCE,
  ensureClaudeCodeDirs,
  probeClaudeCode,
  resolveClaudeCodeBinary
} from '../claudeAgent/claudeCode.js';
import { RUNTIME } from './providerProfile.js';
import { validateWireCapabilities } from './wireCapabilities.js';

const log = createLogger('Preflight');

/**
 * Validate a Responses profile and warm its credential.
 *
 * @param {object} profile - from resolveProviderProfile()
 * @returns {Promise<{ wireOk: boolean, credentialOk: boolean }>}
 * @throws when the profile does not meet the minimum wire contract
 */
async function _runResponsesPreflight(profile) {
  const { wire, baseUrl } = profile.responses;
  const check = validateWireCapabilities(wire);
  if (!check.ok) {
    throw new Error(
      `Provider "${profile.id}" cannot drive the GemiX main brain: `
      + `missing wire capabilities ${check.missing.join(', ')}.`
    );
  }

  log.info(`   Provider: ${profile.id} — ${profile.displayName} (${profile.model}) at ${baseUrl || '(from credential)'}`);
  // This is the profile's explicit contract, not a synthetic model request.
  // Actual endpoint conformance is then exercised by normal Responses calls.
  const optional = [];
  if (wire.supportsMaxOutputTokens) optional.push('max_output_tokens');
  if (wire.supportsPromptCacheKey) optional.push('prompt_cache_key');
  if (wire.supportsStrictFunctionArguments) optional.push('strict function arguments');
  if (wire.supportsFunctionOutputSchema) optional.push('function output_schema');
  const optionalText = optional.length > 0 ? `, optional: ${optional.join(', ')}` : '';
  log.info(`   Declared wire: Responses+SSE, function calling, strict json_schema, reasoning replay, vision${optionalText}`);

  const credentialProvider = getCredentialProvider();
  let credentialOk = false;
  try {
    const credential = await credentialProvider.get();
    credentialOk = Boolean(credential?.accessToken);
    const expiry = Number.isFinite(credential?.expiresAtMs)
      ? ` (valid for ${Math.max(0, Math.round((credential.expiresAtMs - Date.now()) / 60000))} more minute(s))`
      : '';
    log.info(`   Credentials: ${credentialProvider.describe()}${expiry}`);
    if (!credentialOk) {
      log.warn('   Credential resolved but carries no access token — the first model call may fail');
    }
  } catch (err) {
    log.warn(`   Credential preflight failed (${err.message}) — check the .env settings for this profile`);
  }

  return { wireOk: true, credentialOk };
}

/**
 * Check that Claude Code is installed, starts on the subscription token and
 * offers the configured model, without sending it a message.
 *
 * @param {object} profile - from resolveProviderProfile()
 * @returns {Promise<{ accountOk: boolean }>}
 * @throws when no Claude Code binary is installed, or when Claude Code would
 *   run on anything but the subscription token
 */
async function _runClaudeAgentPreflight(profile) {
  const { claudeAgent } = profile;
  if (!resolveClaudeCodeBinary()) {
    throw new Error(
      `Provider "${profile.id}" needs Claude Code, but no binary for ${process.platform}-${process.arch} `
      + 'is installed: run `npm install`.'
    );
  }
  ensureClaudeCodeDirs(claudeAgent);
  log.info(`   Provider: ${profile.id} — ${profile.displayName} (${profile.model}) via Agent SDK `
    + `${pkg.dependencies['@anthropic-ai/claude-agent-sdk']}, up to ${claudeAgent.maxConcurrentTurns} turn(s) at once`);

  let probe;
  try {
    probe = await probeClaudeCode(claudeAgent);
  } catch (err) {
    log.warn(`   Claude Code probe failed (${err.message}) — each turn still checks its credential`);
    return { accountOk: false };
  }

  const { account, models } = probe;
  const apiKeySource = account.apiKeySource && account.apiKeySource !== 'none' ? account.apiKeySource : null;
  if (account.tokenSource !== SUBSCRIPTION_TOKEN_SOURCE || apiKeySource) {
    throw new Error(
      `Provider "${profile.id}" must run on the Claude subscription token, but Claude Code resolved `
      + `${apiKeySource ? `the API credential ${apiKeySource}` : `the token source ${account.tokenSource || 'none'}`}: `
      + 'its turns could bill the pay-per-use API.'
    );
  }
  const plan = account.subscriptionType ? `, ${account.subscriptionType} plan` : '';
  log.info(`   Credentials: Claude subscription token (${account.tokenSource}${plan})`);

  const offered = models.flatMap(model => [model.value, model.resolvedModel]).filter(Boolean);
  if (!offered.includes(profile.model)) {
    log.warn(`   Claude Code does not list ${profile.model} (offers ${offered.join(', ') || 'nothing'}); `
      + 'turns will still request it');
  }
  return { accountOk: true };
}

const RUNTIME_PREFLIGHTS = Object.freeze({
  [RUNTIME.RESPONSES]: _runResponsesPreflight,
  [RUNTIME.CLAUDE_AGENT]: _runClaudeAgentPreflight
});

/**
 * Run the startup check of the runtime the profile names.
 *
 * @param {object} profile - from resolveProviderProfile()
 * @returns {Promise<object>} the runtime check's own summary
 * @throws when the profile can never drive the main brain
 */
async function runProviderPreflight(profile) {
  const preflight = RUNTIME_PREFLIGHTS[profile.runtime];
  if (!preflight) throw new Error(`No startup check for the "${profile.runtime}" runtime.`);
  return preflight(profile);
}

/** One line per bound feature, so the active routing is visible in the boot log. */
function logFeatureBindings(profile) {
  const entries = Object.entries(profile.features || {});
  if (entries.length === 0) return;
  const rendered = entries.map(([feature, backend]) => `${feature}=${backend}`).join(' ');
  log.info(`   Features: ${rendered}`);
}

export { runProviderPreflight, logFeatureBindings };
