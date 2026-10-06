// src/ai/claudeAgent/claudeCode.js
//
// The Claude Code process behind the Claude Agent runtime: which binary runs,
// with which environment and in which directories, and the probe that starts
// it at boot without sending it a message.
//
// The environment is the economic guard of the whole runtime. It is built from
// an allowlist and never copied from this process, so the only credential
// Claude Code can see is the subscription token: an ANTHROPIC_API_KEY or
// ANTHROPIC_AUTH_TOKEN would outrank it and bill the pay-per-use API instead.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import pkg from '../../../package.json' with { type: 'json' };
import envConfig from '../../config/env.js';

const require = createRequire(import.meta.url);

/** The token source Claude Code reports when it runs on the subscription token. */
const SUBSCRIPTION_TOKEN_SOURCE = 'CLAUDE_CODE_OAUTH_TOKEN';

/** How long the boot probe waits for Claude Code to start. */
const PROBE_TIMEOUT_MS = 30_000;

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

/**
 * Start Claude Code with no message to send and read what it resolved: the
 * account behind its credential and the models it offers. Nothing reaches the
 * model, so the probe costs nothing from the plan; it does not prove that the
 * server still accepts the token.
 *
 * @param {{ configDir: string, workDir: string, oauthToken: string }} claudeAgent
 * @returns {Promise<{ account: object, models: object[] }>}
 */
async function probeClaudeCode({ configDir, workDir, oauthToken }) {
  let endInput;
  const inputEnded = new Promise(resolve => { endInput = resolve; });
  async function* noMessages() { await inputEnded; }

  const session = query({
    prompt: noMessages(),
    options: {
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      persistSession: false,
      cwd: workDir,
      env: claudeCodeEnv({ configDir, oauthToken })
    }
  });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Claude Code did not start within ${PROBE_TIMEOUT_MS / 1000}s`)),
        PROBE_TIMEOUT_MS
      );
    });
    const init = await Promise.race([session.initializationResult(), timeout]);
    return { account: init.account || {}, models: Array.isArray(init.models) ? init.models : [] };
  } finally {
    clearTimeout(timer);
    endInput();
    session.close();
  }
}

export {
  SUBSCRIPTION_TOKEN_SOURCE,
  claudeCodeEnv,
  ensureClaudeCodeDirs,
  probeClaudeCode,
  resolveClaudeCodeBinary
};
