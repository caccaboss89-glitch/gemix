// src/sandbox/buildSandbox.js
//
// Per-workspace docker container manager for the `build` sub-agent.
//
// One container per `workspaceId`, lazily started on first use, reused as
// long as the user keeps interacting (sandboxes that stay idle past
// SANDBOX_IDLE_TTL_MS are reaped). Bind mounts:
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

const crypto = require('crypto');
const stream = require('stream');

const {
  SANDBOX_MEMORY_MB,
  SANDBOX_IDLE_TTL_MS,
  BUILD_HARD_TIMEOUT_MS,
  BUILD_MAX_ROUNDS,
} = require('../config/constants');
const {
  GEMIX_SANDBOX_IMAGE,
  GEMIX_SANDBOX_NETWORK,
  GEMIX_SANDBOX_PROXY_HOST,
  GEMIX_SANDBOX_PROXY_PORT,
} = require('../config/env');

const { workspaceIdToSlug } = require('../utils/workspaceId');
const { ensureWorkspace, ensureWorkspaceWritable, sandboxUserString } = require('./buildWorkspace');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildSandbox');

const SANDBOX_IMAGE = GEMIX_SANDBOX_IMAGE;
const SANDBOX_NETWORK = GEMIX_SANDBOX_NETWORK;
const PROXY_HOSTNAME = GEMIX_SANDBOX_PROXY_HOST;
const PROXY_PORT = GEMIX_SANDBOX_PROXY_PORT;

/** Map<workspaceId, BuildSandboxEntry> */
const _pool = new Map();

let _docker = null;
function _getDocker() {
  if (_docker) return _docker;
  let Docker;
  try { Docker = require('dockerode'); }
  catch (e) {
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

  const docker = _getDocker();
  const memBytes = SANDBOX_MEMORY_MB * 1024 * 1024;

  const binds = [
    `${workspaceDir}:/workspace:rw`,
  ];

  const env = [
    'HOME=/tmp',
    // Grok CLI session/cache under tmpfs only — never under /workspace (harvest).
    'GROK_HOME=/tmp/gemix-grok',
    'GROK_DISABLE_AUTOUPDATER=1',
    'GEMIX_BUILD=1',
    // All outbound traffic (curl/wget/yt-dlp/requests/grok) goes through the
    // egress proxy → residential SOCKS5 (Redmi). Fail-closed when Redmi is off.
    `HTTP_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `HTTPS_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `http_proxy=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `https_proxy=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    'NO_PROXY=localhost,127.0.0.1',
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
    Tmpfs: { '/tmp': 'size=256m' },
    Binds: binds,
    RestartPolicy: { Name: 'no' },
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
      'gemix.workspaceId': workspaceId,
    },
  };

  const container = await docker.createContainer(createOpts);
  await container.start();

  return {
    workspaceId,
    container,
    containerId: container.id,
    containerName,
    lastUsedAt: Date.now(),
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
async function _killGrokProcesses(entry) {
  if (!entry || !entry.container) return;
  try {
    const exec = await entry.container.exec({
      Cmd: ['/bin/bash', '-lc', 'pkill -9 -f "[g]rok" 2>/dev/null || true'],
      AttachStdout: false,
      AttachStderr: false,
      User: sandboxUserString(),
      WorkingDir: '/tmp',
    });
    const s = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      s.on('end', resolve);
      s.on('close', resolve);
      s.on('error', resolve);
      setTimeout(resolve, 3000).unref?.();
    });
  } catch (err) {
    log.debug(`pkill grok: ${err.message}`);
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
    Math.min(Number(timeoutMs) || BUILD_HARD_TIMEOUT_MS, BUILD_HARD_TIMEOUT_MS),
  );
  const turns = Math.max(1, Math.min(Number(maxTurns) || BUILD_MAX_ROUNDS, BUILD_MAX_ROUNDS));
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
    '--max-turns', String(turns),
  ];
  if (rulesText.trim()) {
    cmd.push('--rules', rulesText);
  }
  const proxyUrl = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;
  const env = [
    `XAI_API_KEY=${token.trim()}`,
    'HOME=/tmp',
    'GROK_HOME=/tmp/gemix-grok',
    'GROK_DISABLE_AUTOUPDATER=1',
    'GEMIX_BUILD=1',
    `HTTP_PROXY=${proxyUrl}`,
    `HTTPS_PROXY=${proxyUrl}`,
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    'NO_PROXY=localhost,127.0.0.1',
  ];
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    const base = baseUrl.trim().replace(/\/+$/, '');
    env.push(`XAI_BASE_URL=${base}`);
  }
  return { cmd, env, timeoutMs: timeout };
}

/**
 * Run Grok Build CLI inside the workspace sandbox (one-shot docker exec).
 * Auth is process-env only for this exec — never host auth mounts.
 *
 * @param {string} workspaceId
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.rules
 * @param {string} opts.token
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTurns]
 * @returns {Promise<{rc:number,stdout:string,stderr:string,timedOut:boolean,durationMs:number,cmd:string[]}>}
 */
async function execGrokBuild(workspaceId, opts = {}) {
  const { cmd, env, timeoutMs } = buildGrokExecSpec(opts);
  const entry = await getOrCreate(workspaceId);
  entry.lastUsedAt = Date.now();

  const exec = await entry.container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: sandboxUserString(),
    WorkingDir: '/workspace',
    Env: env,
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
    await _killGrokProcesses(entry);
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
    cmd: cmd.map((c, i) => (i > 0 && cmd[i - 1] === '--rules' ? '[rules]' : c)),
  };
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
  try { docker = _getDocker(); }
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
    if (now - entry.lastUsedAt > SANDBOX_IDLE_TTL_MS) {
      log.info(`reaping idle build sandbox ${workspaceId} (idle ${(now - entry.lastUsedAt) / 1000 | 0}s)`);
      _pool.delete(workspaceId);
      _killEntry(entry).catch(err => log.warn(`reap kill failed: ${err.message}`));
    }
  }
}, 60_000);
_reaper.unref();

cleanupOrphanBuildSandboxes().catch(err => log.error(`Background orphan cleanup failed: ${err.message}`));

module.exports = {
  getOrCreate,
  execGrokBuild,
  buildGrokExecSpec,
  shutdown,
  shutdownAll,
  cleanupOrphanBuildSandboxes,
  // Diagnostics
  _pool,
};