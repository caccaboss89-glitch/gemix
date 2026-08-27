// src/ai/providers/preflight.js
//
// The startup check for the profile this process runs on.
//
// Two things are checked, in this order:
//   1. the profile declaration — a profile that does not declare every required
//      Responses/SSE/function/schema/replay/vision capability is refused;
//   2. the credential — resolved once so a misconfiguration surfaces at boot
//      instead of on the first user message.
//
// The credential half is deliberately soft: a token that is missing at boot may
// well be there by the first message, and taking the bot off every platform for
// it would be worse than a warning. The wire half is hard, because it is a
// configuration error that cannot fix itself.

import { createLogger } from '../../utils/logger.js';
import { validateWireCapabilities } from './wireCapabilities.js';

const log = createLogger('Preflight');

/**
 * Validate a resolved profile and warm its credential.
 *
 * @param {object} profile - from resolveProviderProfile()
 * @param {import('../credentials/credentialProvider.js').CredentialProvider} credentialProvider
 * @returns {Promise<{ wireOk: boolean, credentialOk: boolean }>}
 * @throws when the profile does not meet the minimum wire contract
 */
async function runProviderPreflight(profile, credentialProvider) {
  const check = validateWireCapabilities(profile.wire);
  if (!check.ok) {
    throw new Error(
      `Provider "${profile.id}" cannot drive the GemiX main brain: `
      + `missing wire capabilities ${check.missing.join(', ')}.`
    );
  }

  const baseUrl = profile.baseUrl || '(from credential)';
  log.info(`   Provider: ${profile.id} — ${profile.displayName} (${profile.model}) at ${baseUrl}`);
  // This is the profile's explicit contract, not a synthetic model request.
  // Actual endpoint conformance is then exercised by normal Responses calls.
  const optional = [];
  if (profile.wire.supportsMaxOutputTokens) optional.push('max_output_tokens');
  if (profile.wire.supportsPromptCacheKey) optional.push('prompt_cache_key');
  if (profile.wire.supportsStrictFunctionArguments) optional.push('strict function arguments');
  if (profile.wire.supportsFunctionOutputSchema) optional.push('function output_schema');
  const optionalText = optional.length > 0 ? `, optional: ${optional.join(', ')}` : '';
  log.info(`   Declared wire: Responses+SSE, function calling, strict json_schema, reasoning replay, vision${optionalText}`);

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

/** One line per bound feature, so the active routing is visible in the boot log. */
function logFeatureBindings(profile) {
  const entries = Object.entries(profile.features || {});
  if (entries.length === 0) return;
  const rendered = entries.map(([feature, backend]) => `${feature}=${backend}`).join(' ');
  log.info(`   Features: ${rendered}`);
}

export { runProviderPreflight, logFeatureBindings };
