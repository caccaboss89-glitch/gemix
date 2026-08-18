// src/utils/hermesAuthRefresh.js
//
// When GemiX reads expired OAuth tokens from ~/.hermes/auth.json, Hermes CLI
// must run a real API call to refresh them. A one-shot chat ping does that.
//
// The provider is always passed in by the caller — refreshing "xai-oauth" does
// nothing for a stale `openai-codex` token and vice versa. Concurrent callers
// share one in-flight run per (provider, auth file) pair, so a burst of 401s
// across the transport, the image generator and Build spawns a single CLI
// invocation instead of one each.

import fs from 'fs';
import { spawn  } from 'child_process';
import { createLogger  } from './logger.js';
import envConfig from '../config/env.js';

const log = createLogger('Hermes');

const { HERMES_REFRESH_TIMEOUT_MS, HERMES_REFRESH_QUERY } = envConfig;

/** Map<`${provider}|${authFile}`, Promise> — one refresh per pair. */
const _refreshInFlight = new Map();

function _runHermesRefresh(provider) {
  const args = [
    'chat',
    '-q', HERMES_REFRESH_QUERY,
    '--provider', provider,
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

/** mtime+size of the auth file, or null when it cannot be read. */
function _authFileStamp(authFile) {
  if (!authFile) return null;
  try {
    const st = fs.statSync(authFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Ask Hermes to refresh the auth file by sending a minimal request on the given
 * provider. Concurrent callers share one in-flight refresh per provider/file.
 *
 * The file is stamped before and after: Hermes exiting 0 without touching the
 * configured file means the credential the caller is about to retry with is
 * still the stale one, which is worth saying out loud rather than silently
 * retrying into the same 401.
 *
 * @param {string} providerId - Hermes provider/pool name (e.g. 'xai-oauth')
 * @param {string} authFile - the auth.json this caller reads
 * @returns {Promise<string>} Hermes response text on success.
 */
async function refreshHermesOAuth(providerId, authFile) {
  const provider = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim()
    : envConfig.HERMES_REFRESH_PROVIDER;
  const key = `${provider}|${authFile || ''}`;

  const pending = _refreshInFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    log.warn(`Invoking Hermes OAuth refresh for provider "${provider}"...`);
    const before = _authFileStamp(authFile);
    const reply = await _runHermesRefresh(provider);
    const after = _authFileStamp(authFile);
    if (authFile && before !== null && before === after) {
      log.warn(`Hermes exited cleanly but did not update ${authFile} — the credential may still be stale.`);
    } else {
      log.info('Hermes OAuth refresh completed — auth file updated.');
    }
    return reply;
  })().finally(() => {
    _refreshInFlight.delete(key);
  });

  _refreshInFlight.set(key, run);
  return run;
}

export { refreshHermesOAuth
};
