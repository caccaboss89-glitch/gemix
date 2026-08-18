// src/ai/providers/preflight.js
//
// The startup check for whichever back end this process runs on.
//
// It is deliberately soft: a failure is logged and startup continues, because
// a credential that is missing at boot may well be there by the first message,
// and refusing to start would take the bot off every platform for it.
//
// The two profiles check different things because different things can be
// checked. xAI answers an unauthenticated-cheap `GET /models`, so the ping is
// worth making. The Codex backend has no equivalent free route, and probing it
// would spend a real request on a question already answered — so the OpenAI
// preflight validates the Hermes credential locally and says how long it has
// left, without any network call.

import envConfig from '../../config/env.js';
import { getXaiAuth, describeXaiAuthSource } from '../../config/xaiAuth.js';
import { getOpenAiAuth, describeOpenAiAuthSource } from '../../config/openaiAuth.js';
import { PROVIDER } from './providerProfile.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Preflight');

/** How long the xAI reachability ping is allowed to take. */
const PING_TIMEOUT_MS = 3000;

async function _xaiPreflight(profile) {
  const { token, baseUrl } = getXaiAuth();
  log.info(`   xAI API: ${baseUrl} (model: ${profile.model}, auth: ${describeXaiAuthSource()})`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  const res = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: ctrl.signal
  }).catch(() => null);
  clearTimeout(timer);
  if (res && res.ok) {
    log.info('   xAI API reachable');
  } else {
    log.warn(`   xAI preflight returned status ${res ? res.status : 'no-response'} - first AI call may fail`);
  }
}

function _openaiPreflight(profile) {
  const auth = getOpenAiAuth();
  log.info(`   OpenAI API: ${envConfig.OPENAI_BASE_URL} (model: ${profile.model}, auth: ${describeOpenAiAuthSource()})`);
  if (auth.expiresAtMs === null) {
    log.info('   OpenAI credential loaded (no expiry recorded)');
    return;
  }
  const minutesLeft = Math.round((auth.expiresAtMs - Date.now()) / 60000);
  if (minutesLeft <= 0) {
    log.warn('   OpenAI credential is already expired - it is refreshed on the first call');
  } else {
    log.info(`   OpenAI credential valid for ${minutesLeft} more minute(s)`);
  }
}

/**
 * Run the active profile's startup check. Never throws: the caller keeps
 * booting either way.
 *
 * @param {object} profile - the resolved ProviderProfile
 * @returns {Promise<void>}
 */
async function runProviderPreflight(profile) {
  try {
    if (profile.id === PROVIDER.OPENAI) _openaiPreflight(profile);
    else await _xaiPreflight(profile);
  } catch (err) {
    log.warn(`   ${profile.displayName} auth preflight failed (${err.message}) - check the credentials for this provider`);
  }
}

export { runProviderPreflight };
