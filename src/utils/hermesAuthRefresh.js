// src/utils/hermesAuthRefresh.js
//
// When GemiX reads expired OAuth tokens from ~/.hermes/auth.json, Hermes CLI
// must run a real API call to refresh them. A one-shot chat ping does that.

const { spawn } = require('child_process');
const { createLogger } = require('./logger');
const { HERMES_BIN } = require('../config/env');

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
    '--max-turns', '1',
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(HERMES_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      return reject(new Error(`Cannot start ${HERMES_BIN}: ${err.message}`));
    }

    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`Hermes refresh timed out after ${HERMES_REFRESH_TIMEOUT_MS / 1000}s`));
    }, HERMES_REFRESH_TIMEOUT_MS);
    killer.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(new Error(`Hermes process error: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        const detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 500);
        return reject(new Error(`Hermes exited with code ${code}: ${detail}`));
      }
      resolve(stdout.trim());
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
    log.warn(`Invoking Hermes OAuth refresh (${HERMES_BIN} chat -q "${HERMES_REFRESH_QUERY}")...`);
    const reply = await _runHermesRefresh();
    log.info('Hermes OAuth refresh completed — auth file should be updated.');
    return reply;
  })().finally(() => {
    _refreshInFlight = null;
  });

  return _refreshInFlight;
}

module.exports = { refreshHermesOAuth };
