// src/utils/hermesAuthRefresh.js
//
// When GemiX reads expired OAuth tokens from ~/.hermes/auth.json, Hermes CLI
// must run a real API call to refresh them. A one-shot chat ping does that.

import { spawn  } from 'child_process';
import { createLogger  } from './logger.js';
import envConfig from '../config/env.js';

const log = createLogger('Hermes');

const HERMES_REFRESH_TIMEOUT_MS = Number(process.env.HERMES_REFRESH_TIMEOUT_MS) || 120_000;
const HERMES_REFRESH_QUERY = process.env.HERMES_REFRESH_QUERY || 'ciao';
const HERMES_REFRESH_PROVIDER = process.env.HERMES_REFRESH_PROVIDER || 'xai-oauth';

let _refreshInFlight = null;

function _runHermesRefresh() {
  const args = [
    'chat',
    '-q', HERMES_REFRESH_QUERY,
    '--provider', HERMES_REFRESH_PROVIDER,
    '--quiet',
    '--ignore-user-config',
    '--ignore-rules',
    '--max-turns', '1'
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(envConfig.HERMES_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      });
    } catch (err) {
      return reject(new Error(`Cannot start ${envConfig.HERMES_BIN}: ${err.message}`));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      fn(value);
    };

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(reject, new Error(`Hermes refresh timed out after ${HERMES_REFRESH_TIMEOUT_MS / 1000}s`));
    }, HERMES_REFRESH_TIMEOUT_MS);
    killer.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      settle(reject, new Error(`Hermes process error: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 500);
        return settle(reject, new Error(`Hermes exited with code ${code}: ${detail}`));
      }
      settle(resolve, stdout.trim());
    });
  });
}

/**
 * Ask Hermes to refresh ~/.hermes/auth.json by sending a minimal Grok request.
 * Concurrent callers share one in-flight refresh.
 *
 * @returns {Promise<string>} Hermes response text on success.
 */
async function refreshHermesOAuth() {
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    log.warn(`Invoking Hermes OAuth refresh (${envConfig.HERMES_BIN} chat -q "${HERMES_REFRESH_QUERY}")...`);
    const reply = await _runHermesRefresh();
    log.info('Hermes OAuth refresh completed — auth file should be updated.');
    return reply;
  })().finally(() => {
    _refreshInFlight = null;
  });

  return _refreshInFlight;
}

export { refreshHermesOAuth 
};
