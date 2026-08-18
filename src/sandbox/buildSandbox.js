// src/sandbox/buildSandbox.js
//
// Per-workspace docker container manager for the `build` sub-agent.
//
// One container per `workspaceId`, lazily started on first use, reused as
// long as the user keeps interacting (sandboxes that stay idle past
// constants.SANDBOX_IDLE_TTL_MS are reaped). Bind mounts:
//
//   /workspace/  -> host build_workspace dir for this workspaceId  (rw)
//
// Grok Build CLI is baked into the image. The host runs `docker exec grok …`
// with cwd /workspace (see execGrokBuild). Auth is injected per-exec only
// (XAI_API_KEY from getXaiAuth) — never host ~/.hermes or ~/.grok mounts.
//
// Notes:
//   - The base image ENTRYPOINT is overridden with
//     `Cmd:['sleep','infinity']` + `Entrypoint:[]` so the container is
//     a quiet idle process we can attach to.
//   - All egress (curl/wget/yt-dlp/requests/grok API) goes through the egress
//     proxy, which forwards upstream via the residential SOCKS5 (Redmi).

import crypto from 'crypto';
import path from 'path';
import stream from 'stream';

import constants from '../config/constants.js';
import envConfig from '../config/env.js';

import { workspaceIdToSlug  } from '../utils/workspaceId.js';
import { ensureWorkspace, ensureWorkspaceWritable, sandboxUserString  } from './buildWorkspace.js';
import { createLogger  } from '../utils/logger.js';

const log = createLogger('BuildSandbox');

const SANDBOX_IMAGE = envConfig.GEMIX_SANDBOX_IMAGE;
const SANDBOX_NETWORK = envConfig.GEMIX_SANDBOX_NETWORK;
const PROXY_HOSTNAME = envConfig.GEMIX_SANDBOX_PROXY_HOST;
const PROXY_PORT = envConfig.GEMIX_SANDBOX_PROXY_PORT;

/** Map<workspaceId, BuildSandboxEntry> */
const _pool = new Map();

let _docker = null;
async function _getDocker() {
  if (_docker) return _docker;
  let Docker;
  try {
    const dockerodeModule = await import('dockerode');
    Docker = dockerodeModule.default;
  }
  catch {
    throw new Error('dockerode is not installed. Run `npm install` first.');
  }
  _docker = new Docker();
  return _docker;
}

/**
 * Spawn a fresh container for `workspaceId`. Idle `sleep infinity` PID 1;
 * Grok Build (and optional debug shells) attach via docker exec.
 */
async function _spawnContainer(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) throw new Error('Cannot resolve workspace slug');

  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) throw new Error('Cannot ensure workspace directory');
  ensureWorkspaceWritable(workspaceId);

  const containerName = `gemix-bw-${slug}-${crypto.randomBytes(3).toString('hex')}`
    .toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63);

  const docker = await _getDocker();
  const memBytes = constants.SANDBOX_MEMORY_MB * 1024 * 1024;

  const binds = [
    `${workspaceDir}:/workspace:rw`
  ];

  // HOME/GROK_HOME on rootfs (not /tmp): Docker tmpfs defaults to noexec, which
  // breaks the Grok CLI wrapper that spawns ~/.grok/bin/grok (EACCES).
  const env = [
    'HOME=/var/lib/gemix-grok',
    'GROK_HOME=/var/lib/gemix-grok',
    'GROK_DISABLE_AUTOUPDATER=1',
    'GEMIX_BUILD=1',
    // All outbound traffic (curl/wget/yt-dlp/requests/grok) goes through the
    // egress proxy → residential SOCKS5 (Redmi). Fail-closed when Redmi is off.
    `HTTP_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `HTTPS_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `http_proxy=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `https_proxy=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    'NO_PROXY=localhost,127.0.0.1'
  ];

  const hostConfig = {
    NetworkMode: SANDBOX_NETWORK,
    AutoRemove: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: 200,
    Memory: memBytes,
    MemorySwap: memBytes,
    NanoCpus: 1_000_000_000, // 1 CPU
    // exec required if anything stages binaries under /tmp
    Tmpfs: { '/tmp': 'size=256m,exec,mode=1777' },
    Binds: binds,
    RestartPolicy: { Name: 'no' }
  };


  const createOpts = {
    name: containerName,
    Image: SANDBOX_IMAGE,
    Hostname: 'build',
    // Override image defaults so the container is a quiet idle process we
    // attach to via docker exec (bash helpers + Grok Build CLI).
    Entrypoint: [],
    Cmd: ['sleep', 'infinity'],
    User: sandboxUserString(),
    Env: env,
    HostConfig: hostConfig,
    Labels: {
      'gemix.kind': 'build-workspace',
      'gemix.workspaceId': workspaceId
    }
  };

  const container = await docker.createContainer(createOpts);
  await container.start();

  return {
    workspaceId,
    container,
    containerId: container.id,
    containerName,
    lastUsedAt: Date.now()
  };
}

/**
 * Public API: get (or spawn) the running container for this workspace.
 * Concurrent calls share the same boot promise.
 */
async function getOrCreate(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required');

  let entry = _pool.get(workspaceId);
  if (entry && entry._bootPromise) {
    await entry._bootPromise;
    const ready = _pool.get(workspaceId);
    if (!ready || !ready.container) {
      throw new Error(`build sandbox boot failed for ${workspaceId}`);
    }
    ready.lastUsedAt = Date.now();
    return ready;
  }
  if (entry) {
    // Validate the container is still alive on docker side.
    try {
      const info = await entry.container.inspect();
      if (info.State && info.State.Running) {
        entry.lastUsedAt = Date.now();
        return entry;
      }
    } catch { /* container gone */ }
    log.warn(`Stale build sandbox for ${workspaceId}, recreating`);
    await _killEntry(entry).catch(err => log.warn(`stale purge: ${err.message}`));
    _pool.delete(workspaceId);
  }

  // Another concurrent caller may have started boot while we were checking.
  entry = _pool.get(workspaceId);
  if (entry && entry._bootPromise) {
    await entry._bootPromise;
    const ready = _pool.get(workspaceId);
    if (!ready || !ready.container) {
      throw new Error(`build sandbox boot failed for ${workspaceId}`);
    }
    ready.lastUsedAt = Date.now();
    return ready;
  }
  if (entry && entry.container) {
    entry.lastUsedAt = Date.now();
    return entry;
  }

  const bootPromise = _spawnContainer(workspaceId);
  const placeholder = { _bootPromise: bootPromise };
  _pool.set(workspaceId, placeholder);

  try {
    const fresh = await bootPromise;
    fresh.lastUsedAt = Date.now();
    _pool.set(workspaceId, fresh);
    log.info(`build sandbox ready workspace=${workspaceId} container=${fresh.containerName}`);
    return fresh;
  } catch (err) {
    _pool.delete(workspaceId);
    throw err;
  }
}

const CAPTURE_MAX_BYTES = 200 * 1024;

function _capBufferChunks(chunks, maxBytes = CAPTURE_MAX_BYTES) {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total <= maxBytes) return Buffer.concat(chunks).toString('utf-8');
  // Keep the tail (most relevant for errors / final text).
  const out = Buffer.alloc(maxBytes);
  let remaining = maxBytes;
  let offset = maxBytes;
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    const take = Math.min(remaining, chunk.length);
    offset -= take;
    chunk.copy(out, offset, chunk.length - take);
    remaining -= take;
  }
  return out.toString('utf-8');
}

/**
 * Best-effort kill leftover grok processes inside the sandbox after timeout.
 */
/**
 * Kill whatever the runner left behind, by argv pattern. The bracket trick keeps
 * pkill from matching its own command line.
 * @param {object} entry - pool entry
 * @param {string} pattern - already bracketed, e.g. '[g]rok'
 */
async function _killRunnerProcesses(entry, pattern) {
  if (!entry || !entry.container) return;
  try {
    const exec = await entry.container.exec({
      Cmd: ['/bin/bash', '-lc', `pkill -9 -f "${pattern}" 2>/dev/null || true`],
      AttachStdout: false,
      AttachStderr: false,
      User: sandboxUserString(),
      WorkingDir: '/tmp'
    });
    const s = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      s.on('end', resolve);
      s.on('close', resolve);
      s.on('error', resolve);
      setTimeout(resolve, 3000).unref?.();
    });
  } catch (err) {
    log.debug(`pkill ${pattern}: ${err.message}`);
  }
}

/**
 * Build argv + env for an in-container Grok Build run (pure; testable without Docker).
 *
 * Docker ExecConfig.Env replaces the process environment entirely when set
 * (does not inherit the container env), so proxy + HOME must be listed here.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.rules
 * @param {string} opts.token - same live credential as GemiX (Hermes OAuth or API key)
 * @param {string} [opts.baseUrl] - optional API base from getXaiAuth()
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @returns {{ cmd: string[], env: string[], timeoutMs: number }}
 */
function buildGrokExecSpec({ prompt, rules, token, baseUrl, timeoutMs, maxTurns } = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('buildGrokExecSpec: missing xAI token');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('buildGrokExecSpec: missing prompt');
  }
  const timeout = Math.max(
    5_000,
    Math.min(Number(timeoutMs) || constants.BUILD_HARD_TIMEOUT_MS, constants.BUILD_HARD_TIMEOUT_MS)
  );
  const turns = Math.max(1, Math.min(Number(maxTurns) || constants.BUILD_MAX_ROUNDS, constants.BUILD_MAX_ROUNDS));
  const rulesText = typeof rules === 'string' ? rules : '';
  // Free-text stdout (no --output-format json). timeout(1) enforces hard kill.
  const timeoutSec = Math.max(1, Math.ceil(timeout / 1000));
  const cmd = [
    'timeout',
    '--signal=KILL',
    `${timeoutSec}s`,
    'grok',
    '-p', prompt.trim(),
    '--cwd', '/workspace',
    '--always-approve',
    '--no-subagents',
    '--no-auto-update',
    '--max-turns', String(turns)
  ];
  if (rulesText.trim()) {
    cmd.push('--rules', rulesText);
  }
  const proxyUrl = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;
  const env = [
    `XAI_API_KEY=${token.trim()}`,
    'HOME=/var/lib/gemix-grok',
    'GROK_HOME=/var/lib/gemix-grok',
    'GROK_DISABLE_AUTOUPDATER=1',
    'GEMIX_BUILD=1',
    `HTTP_PROXY=${proxyUrl}`,
    `HTTPS_PROXY=${proxyUrl}`,
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    'NO_PROXY=localhost,127.0.0.1'
  ];
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    const base = baseUrl.trim().replace(/\/+$/, '');
    env.push(`XAI_BASE_URL=${base}`);
  }
  return { cmd, env, timeoutMs: timeout };
}

/**
 * Build argv + env for an in-container Codex Build run (pure; testable without
 * Docker).
 *
 * The credential is deliberately absent. The CLI receives an opaque ticket and
 * a base URL that points at the host-side broker (see codexAuthBroker.js): the
 * real bearer and account id are attached outside the container, where the
 * model-controlled shell cannot reach them. Nothing in `cmd` or `env` below is
 * a secret, which is the property the security test asserts.
 *
 * `CODEX_HOME` is a throwaway directory outside /workspace, so config, auth
 * state and session files never appear in the workspace listing, the snapshot
 * or the harvest. The internal sandbox is switched off only because the whole
 * process already runs inside the Docker jail, on an internal network whose
 * single exit is the egress proxy.
 *
 * @param {object} opts
 * @param {string} opts.prompt - the user's brief, kept separate from the rules
 * @param {string} opts.rules - build instructions, passed as developer instructions
 * @param {string} opts.ticket - single-invocation broker ticket (not a credential)
 * @param {string} opts.codexHome - throwaway CODEX_HOME, a container path outside /workspace
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {number} [opts.timeoutMs]
 * @returns {{ cmd: string[], env: string[], timeoutMs: number, rules: string,
 *   codexHome: string, instructionsFile: string }}
 */
function buildCodexExecSpec({
  prompt, rules, ticket, codexHome, model, effort, timeoutMs
} = {}) {
  if (typeof ticket !== 'string' || !ticket.trim()) {
    throw new Error('buildCodexExecSpec: missing broker ticket');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('buildCodexExecSpec: missing prompt');
  }
  if (typeof codexHome !== 'string' || !codexHome.trim() || codexHome.startsWith('/workspace')) {
    throw new Error('buildCodexExecSpec: CODEX_HOME must be set and live outside /workspace');
  }

  const timeout = Math.max(
    5_000,
    Math.min(Number(timeoutMs) || constants.BUILD_HARD_TIMEOUT_MS, constants.BUILD_HARD_TIMEOUT_MS)
  );
  const timeoutSec = Math.max(1, Math.ceil(timeout / 1000));
  const brokerUrl = `http://${envConfig.CODEX_BROKER_HOST}:${envConfig.CODEX_BROKER_PORT}`;
  // Container path, so it is derived with posix rules whatever the host runs on.
  const instructionsFile = path.posix.join(codexHome, 'instructions.md');

  const cmd = [
    'timeout',
    '--signal=KILL',
    `${timeoutSec}s`,
    'codex',
    'exec',
    '--cd', '/workspace',
    '--model', model || envConfig.OPENAI_MODEL,
    '--json',
    '--skip-git-repo-check',
    // Every request is authenticated by the broker, never by the CLI itself.
    '--config', 'model_provider="gemix_broker"',
    '--config', 'model_providers.gemix_broker.name="GemiX broker"',
    // Broker root, with no version segment: the CLI appends `/responses`, which
    // is the only path the broker accepts.
    '--config', `model_providers.gemix_broker.base_url="${brokerUrl}"`,
    '--config', 'model_providers.gemix_broker.env_key="CODEX_BROKER_TICKET"',
    '--config', 'model_providers.gemix_broker.wire_api="responses"',
    '--config', `model_reasoning_effort="${effort}"`,
    // An AGENTS.md staged as a build attachment is data, not instructions.
    '--config', 'project_doc_max_bytes=0',
    '--config', 'experimental_use_freeform_apply_patch=true'
  ];
  cmd.push('--config', `experimental_instructions_file="${instructionsFile}"`);
  // Already inside a locked-down container with no default route; a second
  // sandbox on top of it only breaks the tools the build is meant to use.
  cmd.push('--config', 'sandbox_mode="danger-full-access"');
  cmd.push(prompt.trim());

  const proxyUrl = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;
  const env = [
    `CODEX_BROKER_TICKET=${ticket.trim()}`,
    `CODEX_HOME=${codexHome}`,
    'HOME=/var/lib/gemix-codex',
    'GEMIX_BUILD=1',
    `HTTP_PROXY=${proxyUrl}`,
    `HTTPS_PROXY=${proxyUrl}`,
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    'NO_PROXY=localhost,127.0.0.1'
  ];

  // `rules` travels as developer instructions in a file the CLI reads, never on
  // the command line where it would sit next to the user's brief. execCodexBuild
  // writes it inside the container, at the path named above.
  return {
    cmd,
    env,
    timeoutMs: timeout,
    rules: typeof rules === 'string' ? rules : '',
    codexHome,
    instructionsFile
  };
}

/**
 * Run one build CLI inside the workspace sandbox (one-shot docker exec).
 *
 * Shared by both runners: only the spec, the kill pattern and how the argv is
 * redacted for logging differ between them.
 *
 * @param {string} workspaceId
 * @param {object} spec - { cmd, env, timeoutMs } from a runner's exec spec
 * @param {object} [opts]
 * @param {string} [opts.killPattern] - bracketed pkill pattern for a timeout
 * @param {(cmd: string[]) => string[]} [opts.redactCmd] - argv as it may be logged
 * @returns {Promise<{rc:number,stdout:string,stderr:string,timedOut:boolean,durationMs:number,cmd:string[]}>}
 */
async function _execBuildRunner(workspaceId, spec, opts = {}) {
  const { cmd, env, timeoutMs } = spec;
  const killPattern = opts.killPattern || '[g]rok';
  const entry = await getOrCreate(workspaceId);
  entry.lastUsedAt = Date.now();

  const exec = await entry.container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: sandboxUserString(),
    WorkingDir: '/workspace',
    Env: env
  });

  const startedAt = Date.now();
  const execStream = await exec.start({ hijack: true, stdin: false });

  const stdoutBuf = [];
  const stderrBuf = [];
  const stdoutStream = new stream.PassThrough();
  const stderrStream = new stream.PassThrough();
  stdoutStream.on('data', (chunk) => stdoutBuf.push(chunk));
  stderrStream.on('data', (chunk) => stderrBuf.push(chunk));
  entry.container.modem.demuxStream(execStream, stdoutStream, stderrStream);

  let timedOut = false;
  // Host-side ceiling slightly above in-container `timeout` so stream teardown is a backstop.
  const hostTimeoutMs = timeoutMs + 15_000;
  const timer = setTimeout(() => {
    timedOut = true;
    try { execStream.destroy(new Error('timeout')); } catch { /* ignore */ }
  }, hostTimeoutMs);

  try {
    await new Promise((resolve, reject) => {
      execStream.on('end', resolve);
      execStream.on('close', resolve);
      execStream.on('error', (err) => {
        if (timedOut) resolve();
        else reject(err);
      });
    });
  } finally {
    clearTimeout(timer);
  }

  let rc = 0;
  try {
    const inspect = await exec.inspect();
    rc = typeof inspect.ExitCode === 'number' ? inspect.ExitCode : (timedOut ? 124 : 1);
  } catch {
    rc = timedOut ? 124 : 1;
  }
  // GNU timeout uses 124 on timeout; SIGKILL path is 137.
  if (rc === 124 || rc === 137) timedOut = true;

  if (timedOut) {
    await _killRunnerProcesses(entry, killPattern);
  }

  const durationMs = Date.now() - startedAt;
  ensureWorkspaceWritable(workspaceId);
  entry.lastUsedAt = Date.now();
  return {
    rc,
    stdout: _capBufferChunks(stdoutBuf),
    stderr: _capBufferChunks(stderrBuf),
    timedOut,
    durationMs,
    cmd: typeof opts.redactCmd === 'function' ? opts.redactCmd(cmd) : cmd
  };
}

/**
 * Run Grok Build CLI inside the workspace sandbox.
 * Auth is process-env only for this exec — never host auth mounts.
 *
 * @param {string} workspaceId
 * @param {object} opts - see buildGrokExecSpec
 * @returns {Promise<{rc:number,stdout:string,stderr:string,timedOut:boolean,durationMs:number,cmd:string[]}>}
 */
async function execGrokBuild(workspaceId, opts = {}) {
  return _execBuildRunner(workspaceId, buildGrokExecSpec(opts), {
    killPattern: '[g]rok',
    redactCmd: (cmd) => cmd.map((c, i) => (i > 0 && cmd[i - 1] === '--rules' ? '[rules]' : c))
  });
}

/** Single-quote one argument for `sh -c`. */
function _shQuote(value) {
  return `'${String(value).replace(/'/g, '\'\\\'\'')}'`;
}

/** Run a short `sh -c` inside the container and resolve its exit code. */
async function _containerSh(entry, script, stdin = null) {
  const exec = await entry.container.exec({
    Cmd: ['sh', '-c', script],
    AttachStdin: stdin !== null,
    AttachStdout: true,
    AttachStderr: true,
    User: sandboxUserString(),
    WorkingDir: '/workspace'
  });

  const execStream = await exec.start({ hijack: true, stdin: stdin !== null });
  const sink = new stream.PassThrough();
  const errBuf = [];
  const errStream = new stream.PassThrough();
  errStream.on('data', (chunk) => errBuf.push(chunk));
  sink.on('data', () => { /* drained so the stream can end */ });
  entry.container.modem.demuxStream(execStream, sink, errStream);

  await new Promise((resolve, reject) => {
    execStream.on('end', resolve);
    execStream.on('close', resolve);
    execStream.on('error', reject);
    if (stdin !== null) execStream.end(stdin);
  });

  let rc = 1;
  try {
    const inspect = await exec.inspect();
    if (typeof inspect.ExitCode === 'number') rc = inspect.ExitCode;
  } catch { /* treated as a failure below */ }
  return { rc, stderr: Buffer.concat(errBuf).toString('utf8').trim() };
}

/**
 * Create the throwaway CODEX_HOME inside the container and write the developer
 * instructions into it.
 *
 * The content travels over stdin, never in argv: the rules must not sit next to
 * the user's brief on a command line. The directory lives under
 * /var/lib/gemix-codex, outside /workspace, so the listing, the snapshot and the
 * harvest never see it.
 *
 * @param {object} entry - live sandbox entry
 * @param {object} spec - from buildCodexExecSpec
 */
async function _stageCodexHome(entry, spec) {
  const home = _shQuote(spec.codexHome);
  const script = `mkdir -p ${home} && chmod 700 ${home} && cat > ${_shQuote(spec.instructionsFile)}`;
  const { rc, stderr } = await _containerSh(entry, script, Buffer.from(spec.rules, 'utf8'));
  if (rc !== 0) {
    throw new Error(`could not stage CODEX_HOME in the sandbox (rc=${rc})${stderr ? `: ${stderr}` : ''}`);
  }
}

/** Remove the throwaway CODEX_HOME inside the container. Best effort. */
async function _unstageCodexHome(entry, spec) {
  try {
    const { rc, stderr } = await _containerSh(entry, `rm -rf ${_shQuote(spec.codexHome)}`);
    if (rc !== 0) log.warn(`could not remove CODEX_HOME in the sandbox (rc=${rc})${stderr ? `: ${stderr}` : ''}`);
  } catch (err) {
    log.warn(`could not remove CODEX_HOME in the sandbox: ${err.message}`);
  }
}

/**
 * Run the Codex CLI inside the workspace sandbox.
 *
 * The credential lives on the host: the container only ever holds the broker
 * ticket, and the ticket is redacted out of anything that could be logged. The
 * throwaway CODEX_HOME is created inside the container before the run and
 * removed after it, whatever the run's outcome — a container is reused across
 * builds, so leaving it behind would leak one build's instructions into the next.
 *
 * @param {string} workspaceId
 * @param {object} opts - see buildCodexExecSpec
 * @returns {Promise<{rc:number,stdout:string,stderr:string,timedOut:boolean,durationMs:number,cmd:string[]}>}
 */
async function execCodexBuild(workspaceId, opts = {}) {
  const spec = buildCodexExecSpec(opts);
  const entry = await getOrCreate(workspaceId);
  await _stageCodexHome(entry, spec);
  try {
    return await _execBuildRunner(workspaceId, spec, {
      killPattern: '[c]odex',
      // The brief is the last argument and the ticket never appears in argv, but
      // the prompt itself is user content and does not belong in a log line.
      redactCmd: (cmd) => cmd.map((c, i) => (i === cmd.length - 1 ? '[prompt]' : c))
    });
  } finally {
    await _unstageCodexHome(entry, spec);
  }
}

async function _killEntry(entry) {
  if (entry && entry._bootPromise) {
    try { entry = await entry._bootPromise; }
    catch { return; }
  }
  if (!entry || !entry.container) return;
  try { await entry.container.stop({ t: 2 }); } catch { /* */ }
  try { await entry.container.remove({ force: true }); } catch { /* */ }
}

async function shutdown(workspaceId) {
  const entry = _pool.get(workspaceId);
  if (!entry) return;
  _pool.delete(workspaceId);
  await _killEntry(entry);
  log.info(`build sandbox shut down workspace=${workspaceId}`);
}

async function shutdownAll() {
  const entries = [..._pool.values()];
  _pool.clear();
  await Promise.all(entries.map(e => _killEntry(e).catch(err => log.warn(`shutdownAll: ${err.message}`))));
}

/**
 * Best-effort cleanup of dangling build containers from previous runs.
 * Matches by the `gemix-bw-` name prefix or by the `gemix.kind=build-workspace`
 * label. Called on startup.
 */
async function cleanupOrphanBuildSandboxes() {
  let docker;
  try { docker = await _getDocker(); }
  catch (err) { log.debug(`Orphan cleanup skipped: ${err.message}`); return; }

  try {
    const containers = await docker.listContainers({ all: true });
    const orphans = containers.filter(c =>
      c.Names.some(n => n.startsWith('/gemix-bw-'))
      || (c.Labels && c.Labels['gemix.kind'] === 'build-workspace')
    );
    if (orphans.length === 0) return;

    log.info(`Found ${orphans.length} orphan build sandbox(es). Cleaning up...`);
    for (const cInfo of orphans) {
      try {
        const container = docker.getContainer(cInfo.Id);
        if (cInfo.State === 'running') {
          await container.stop({ t: 2 }).catch(() => {});
        }
        await container.remove({ force: true });
        log.info(`Cleaned up orphan ${cInfo.Names[0]} (${cInfo.Id.slice(0, 12)})`);
      } catch (err) {
        if (err.message && err.message.includes('409') && err.message.includes('already in progress')) {
          log.debug(`Orphan ${cInfo.Id.slice(0, 12)} removal already in progress`);
        } else {
          log.warn(`Failed to cleanup ${cInfo.Id.slice(0, 12)}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.error(`Orphan build sandbox cleanup failed: ${err.message}`);
  }
}

// -- Idle reaper -----------------------------------------------------------
const _reaper = setInterval(() => {
  const now = Date.now();
  for (const [workspaceId, entry] of _pool.entries()) {
    if (!entry.lastUsedAt) continue;
    if (now - entry.lastUsedAt > constants.SANDBOX_IDLE_TTL_MS) {
      log.info(`reaping idle build sandbox ${workspaceId} (idle ${(now - entry.lastUsedAt) / 1000 | 0}s)`);
      _pool.delete(workspaceId);
      _killEntry(entry).catch(err => log.warn(`reap kill failed: ${err.message}`));
    }
  }
}, 60_000);
_reaper.unref();

cleanupOrphanBuildSandboxes().catch(err => log.error(`Background orphan cleanup failed: ${err.message}`));

export default {
  execGrokBuild,
  execCodexBuild,
  buildGrokExecSpec,
  buildCodexExecSpec,
  shutdown,
  shutdownAll
};