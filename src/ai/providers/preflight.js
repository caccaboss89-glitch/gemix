// src/ai/providers/preflight.js
//
// The startup check for the profile this process runs on.
//
// Two things are verified, in this order:
//   1. the wire contract — a profile that cannot carry Responses/SSE/function
//      calling/strict schema/reasoning replay/vision is refused outright, since
//      no amount of retrying at runtime would make it work;
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
  // The required capabilities are listed as prose because they are the same for
  // every provider that got past the check above. The optional ones are named
  // only when present, so the log says what actually differs between backends.
  const optional = profile.wire.supportsMaxOutputTokens ? ', max_output_tokens' : '';
  log.info(`   Wire: Responses+SSE, function calling, strict json_schema, reasoning replay, vision${optional}`);

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
