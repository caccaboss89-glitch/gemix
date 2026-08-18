// src/ai/buildRunners.js
//
// The two build back ends behind one interface.
//
// `build` is a single logical tool: the same workspace, the same lock, quota,
// staging rules, snapshot, harvest and delivery. Only the CLI that runs inside
// the sandbox changes with the provider, so everything that differs — the
// operational rules text, how the run is authenticated, the exec spec, how its
// output is read and what its errors are called — lives here instead of being
// scattered through buildAgent.js as provider conditionals.
//
// The Grok runner is the current one, unchanged: it injects the live xAI
// credential into the exec environment, exactly as before.
//
// The Codex runner never does that. `codex exec` can run shell commands, so a
// bearer in its environment would be readable by the model; instead it gets a
// single-invocation ticket and the real credential is attached by the host-side
// broker (see sandbox/codexAuthBroker.js). Its rules text names Codex Build and
// mentions no xAI tool, endpoint or capability.

import fs from 'fs';
import os from 'os';
import path from 'path';
import constants from '../config/constants.js';
import envConfig from '../config/env.js';
import { PROVIDER } from './providers/providerProfile.js';
import { getXaiAuth } from '../config/xaiAuth.js';
import { getOpenAiAuth } from '../config/openaiAuth.js';
import { mintTicket, revokeTicket, startBroker } from '../sandbox/codexAuthBroker.js';
import buildSandbox from '../sandbox/buildSandbox.js';
import { getRomeTime } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('BuildRunner');

/** Rules every build agent gets, whichever CLI is running. */
function _sharedRuleLines({ networkLine, skillsLine }) {
  return [
    'You are GemiX-Build: complete the task brief inside this isolated container.',
    `Time (Europe/Rome): ${getRomeTime()}.`,
    'Filesystem: work only under /workspace/ (writable). Do not rely on host paths outside it.',
    `Quota: keep the workspace under about ${constants.BUILD_WORKSPACE_QUOTA_MB} MB (host enforces staging caps; do not fill the disk). Files persist for the user session (~${constants.BUILD_WORKSPACE_TTL_LABEL} TTL managed by the host).`,
    networkLine,
    'Toolchain: Python 3.12, Node 22, ffmpeg, yt-dlp, LibreOffice, TeX, zip/unzip, curl/wget. Runtime pip/npm/apt are disabled — do not attempt package installs.',
    skillsLine,
    'IMPORTANT delivery contract: after you finish, the host harvests new/modified files under /workspace/ (and may harvest all files on a successful no-change run, e.g. resend). Write a clear free-text summary of what you did and what files matter; GemiX-Main will select what to send the user.',
    'If GemiX-Main only asks to send/resend files already present: confirm they are under /workspace/ (do not recreate them unless missing) and reply briefly — the host harvests them and forwards to GemiX-Main automatically; you do not list JSON attachments.',
    'Language: write documents in the user\'s language (Italian default). No emojis in your reply or generated files unless the brief asks for them.'
  ];
}

/** The per-run inputs both runners append in the same order. */
function _contextRuleLines({ renamedAttachments, stagedNames, externalUrls }) {
  const lines = [];
  if (Array.isArray(stagedNames) && stagedNames.length > 0) {
    lines.push(`Staged inputs already under /workspace/: ${stagedNames.join(', ')}.`);
  }
  if (Array.isArray(renamedAttachments) && renamedAttachments.length > 0) {
    const renames = renamedAttachments
      .map(a => `"${a.requested}" → on disk "${a.actual}"`)
      .join('; ');
    lines.push(`Upload filename collisions (use the on-disk name): ${renames}.`);
  }
  if (Array.isArray(externalUrls) && externalUrls.length > 0) {
    lines.push(
      'These inputs are only available as public URLs (too large to stage). Download them into /workspace/ if needed: '
      + externalUrls.join(' | ')
    );
  }
  return lines;
}

// -- Grok ---------------------------------------------------------------------

const GROK_RUNNER = {
  id: 'grok',
  label: 'Grok Build',
  rules(opts = {}) {
    return [
      ..._sharedRuleLines({
        networkLine: 'Network: HTTP/HTTPS egress already uses HTTP_PROXY/HTTPS_PROXY (residential), including API calls to xAI. Do not pass --proxy to yt-dlp/curl. On proxy 502, CONNECT errors, timeouts, or DNS failures: internet is down — stop, do not retry loops, explain the system outage in your reply.',
        skillsLine: 'Use your built-in Grok skills and tools as needed.'
      }),
      ..._contextRuleLines(opts)
    ].join('\n');
  },

  /** Resolve the credential this runner injects into the exec environment. */
  async prepare({ getToken } = {}) {
    const auth = typeof getToken === 'function' ? getToken() : getXaiAuth();
    const token = auth && auth.token;
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Cannot load xAI credentials for build: empty token.');
    }
    return {
      execOpts: {
        token: token.trim(),
        baseUrl: typeof auth.baseUrl === 'string' ? auth.baseUrl : undefined,
        maxTurns: constants.BUILD_MAX_ROUNDS
      },
      cleanup: () => {}
    };
  },

  exec(workspaceId, opts) {
    return buildSandbox.execGrokBuild(workspaceId, opts);
  },

  /** Grok writes a free-text reply on stdout. */
  readOutput(stdout) {
    return stdout;
  },

  credentialError(message) {
    return `Cannot load xAI credentials for build: ${message}`;
  }
};

// -- Codex --------------------------------------------------------------------

/** One JSONL line of `codex exec --json` that carries agent-visible text. */
function _codexLineText(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Anything the CLI prints outside its JSONL stream is still readable text.
    return line;
  }
  if (typeof event?.msg?.message === 'string') return event.msg.message;
  if (typeof event?.message === 'string') return event.message;
  if (typeof event?.text === 'string') return event.text;
  if (Array.isArray(event?.content)) {
    return event.content
      .filter(p => p && typeof p.text === 'string')
      .map(p => p.text)
      .join('');
  }
  return '';
}

const CODEX_RUNNER = {
  id: 'codex',
  label: 'Codex Build',
  rules(opts = {}) {
    return [
      ..._sharedRuleLines({
        networkLine: 'Network: HTTP/HTTPS egress already uses HTTP_PROXY/HTTPS_PROXY (residential). Do not pass --proxy to yt-dlp/curl. On proxy 502, CONNECT errors, timeouts, or DNS failures: internet is down — stop, do not retry loops, explain the system outage in your reply.',
        skillsLine: 'Use your built-in tools as needed.'
      }),
      ..._contextRuleLines(opts)
    ].join('\n');
  },

  /**
   * Bring up the auth boundary for one invocation: a throwaway CODEX_HOME
   * outside the workspace, the developer instructions written into it, and a
   * ticket that dies with the run. No credential is produced here — the check
   * below only confirms the host still has one for the broker to use.
   */
  async prepare() {
    getOpenAiAuth({ minRemainingMs: constants.BUILD_HARD_TIMEOUT_MS });
    await startBroker();

    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gemix-codex-'));
    const ticket = mintTicket({ ttlMs: constants.BUILD_HARD_TIMEOUT_MS + 60_000 });
    return {
      execOpts: {
        ticket,
        codexHome,
        model: envConfig.OPENAI_MODEL,
        effort: envConfig.OPENAI_REASONING_EFFORT
      },
      cleanup: () => {
        revokeTicket(ticket);
        try {
          fs.rmSync(codexHome, { recursive: true, force: true });
        } catch (err) {
          log.warn(`could not remove the temporary CODEX_HOME: ${err.message}`);
        }
      }
    };
  },

  exec(workspaceId, opts) {
    // The rules are developer instructions, read from a file inside the
    // throwaway CODEX_HOME so they never sit next to the user's brief and never
    // appear in the workspace.
    const instructionsFile = path.join(opts.codexHome, 'instructions.md');
    fs.writeFileSync(instructionsFile, opts.rules || '', 'utf8');
    return buildSandbox.execCodexBuild(workspaceId, { ...opts, instructionsFile });
  },

  /** Codex writes JSONL; the reply is the text those events carry. */
  readOutput(stdout) {
    if (typeof stdout !== 'string' || !stdout.trim()) return '';
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(_codexLineText)
      .filter(text => text && text.trim())
      .join('\n')
      .trim();
  },

  credentialError(message) {
    return `Cannot load OpenAI credentials for build: ${message}`;
  }
};

const RUNNERS = {
  [PROVIDER.XAI]: GROK_RUNNER,
  [PROVIDER.OPENAI]: CODEX_RUNNER
};

/**
 * The build runner a profile names.
 * @param {object} providerProfile
 * @returns {object} runner interface
 */
function runnerForProfile(providerProfile) {
  const runner = RUNNERS[providerProfile?.id];
  if (!runner) throw new Error(`No build runner for provider "${providerProfile?.id}".`);
  return runner;
}

export {
  GROK_RUNNER,
  CODEX_RUNNER,
  runnerForProfile
};
