// src/ai/claudeAgent/claudeCode.js
//
// The Claude Code process behind the Claude Agent runtime: which binary runs,
// with which environment and in which directories.
//
// The environment is the economic guard of the whole runtime. It is built from
// an allowlist and never copied from this process, so the only credential
// Claude Code can see is the subscription token: an ANTHROPIC_API_KEY or
// ANTHROPIC_AUTH_TOKEN would outrank it and bill the pay-per-use API instead.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import pkg from '../../../package.json' with { type: 'json' };
import envConfig from '../../config/env.js';

const require = createRequire(import.meta.url);

/** The token source Claude Code reports when it runs on the subscription token. */
const SUBSCRIPTION_TOKEN_SOURCE = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The environment of one Claude Code process.
 * @param {{ configDir: string, oauthToken?: string|null }} opts - a null token
 *   suits only commands that create one
 * @returns {Record<string, string>}
 */
function claudeCodeEnv({ configDir, oauthToken = null }) {
  return {
    ...envConfig.SUBPROCESS_BASE_ENV,
    CLAUDE_CONFIG_DIR: configDir,
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: `gemix/${pkg.version}`,
    // The binary is pinned with the SDK; it must neither update itself nor
    // call home beyond the model requests.
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  };
}

/** Whether this Linux host links against musl rather than glibc. */
function _isMusl() {
  return process.platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime;
}

/**
 * The Claude Code binary the SDK's platform package installed for this host,
 * resolved the way the SDK resolves it.
 * @returns {string|null} absolute path, or null when no matching package is installed
 */
function resolveClaudeCodeBinary() {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const packages = process.platform !== 'linux' ? [base]
    : _isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`];
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const name of packages) {
    try {
      const binary = require.resolve(`${name}/${file}`);
      if (fs.existsSync(binary)) return binary;
    } catch { /* this variant is not installed */ }
  }
  return null;
}

/**
 * Create the profile's Claude Code directories, readable by this user only.
 * @param {{ configDir: string, workDir: string }} claudeAgent
 */
function ensureClaudeCodeDirs({ configDir, workDir }) {
  for (const dir of [configDir, workDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export {
  SUBSCRIPTION_TOKEN_SOURCE,
  claudeCodeEnv,
  ensureClaudeCodeDirs,
  resolveClaudeCodeBinary
};
