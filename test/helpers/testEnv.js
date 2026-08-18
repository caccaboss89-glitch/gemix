// test/helpers/testEnv.js
//
// Test-harness bootstrap. src/config/env.js is the only place the application
// reads configuration, and it snapshots process.env at import time; the helpers
// below seed that snapshot (and a throwaway Hermes auth file) BEFORE any src/
// module is imported. Writing process.env here is a documented test-only
// exception to the "all env reads go through src/config/env.js" rule.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const _tempDirs = [];

/** Throwaway directory removed when the process exits. */
function makeTempDir(prefix = 'gemix-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tempDirs.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of _tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Write a Hermes-shaped auth file with fake credentials for both pools.
 * @param {object} [opts]
 * @param {string} [opts.activeProvider] - value of the ignored `active_provider` field
 * @param {Array} [opts.xai] - credential entries for the xai-oauth pool
 * @param {Array} [opts.openai] - credential entries for the openai-codex pool
 * @returns {string} path to the file
 */
function writeAuthFile(opts = {}) {
  const dir = makeTempDir('gemix-auth-');
  const file = path.join(dir, 'auth.json');
  const payload = {
    active_provider: opts.activeProvider || 'xai-oauth',
    credential_pool: {
      'xai-oauth': opts.xai || [{ access_token: 'xai-test-token', base_url: 'https://api.x.ai/v1' }],
      'openai-codex': opts.openai || [{
        access_token: 'openai-test-token',
        account_id: `acct_${crypto.randomBytes(4).toString('hex')}`
      }]
    }
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

/**
 * Seed the environment env.js will snapshot. Must run before importing src/.
 * @param {Record<string, string>} vars
 */
function seedEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

export { makeTempDir, writeAuthFile, seedEnv };
