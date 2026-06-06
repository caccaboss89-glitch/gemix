// src/sandbox/buildSandbox.js
//
// Per-workspace docker container manager for the `build` sub-agent.
//
// One container per `workspaceId`, lazily started on first use, reused as
// long as the user keeps interacting (sandboxes that stay idle past
// SANDBOX_IDLE_TTL_MS are reaped). The bind mounts are flat:
//
//   /workspace/  -> host build_workspace dir for this workspaceId  (rw)
//   /skills/     -> src/data/skills/                                (ro)
//
// No /readonly/history, no /readonly/searched_images. The agent only sees
// files explicitly staged in the workspace by the `build` tool (attachments)
// or written by itself.
//
// Notes:
//   - No Python kernel attached: filesystem work runs via `docker exec`
//     bash, ad-hoc Python is delegated to xAI's server-side
//     code_interpreter (zero round cost).
//   - The base image's ENTRYPOINT (Jupyter Server) is overridden with
//     `Cmd:['sleep','infinity']` + `Entrypoint:[]` so the container is
//     a quiet idle process we can attach to.
//   - Standalone `yt-dlp` bash commands run on the **host** (not in Docker),
//     via tailsocks socks5h://127.0.0.1:5040 — same as SERVER_SETUP.md.
//     Output lands in the bind-mounted build_workspace dir.

const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const stream = require('stream');
const util = require('util');

const execAsync = util.promisify(exec);

const {
  SANDBOX_MEMORY_MB,
  SANDBOX_IDLE_TTL_MS,
  YTDLP_SOCKS_HOST,
  YTDLP_SOCKS_PORT,
} = require('../config/constants');
const {
  GEMIX_SANDBOX_IMAGE,
  GEMIX_SANDBOX_NETWORK,
  GEMIX_SANDBOX_PROXY_HOST,
  GEMIX_SANDBOX_PROXY_PORT,
} = require('../config/env');

const { SKILLS_DIR } = require('../utils/userPaths');
const { workspaceIdToSlug } = require('../utils/workspaceId');
const { ensureWorkspace } = require('./buildWorkspace');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildSandbox');

const SANDBOX_IMAGE = GEMIX_SANDBOX_IMAGE;
const SANDBOX_NETWORK = GEMIX_SANDBOX_NETWORK;
const PROXY_HOSTNAME = GEMIX_SANDBOX_PROXY_HOST;
const PROXY_PORT = GEMIX_SANDBOX_PROXY_PORT;

const GEMIX_BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const YTDLP_BIN_HOST_PATH = path.join(GEMIX_BIN_DIR, 'yt-dlp');

/** Fail fast at pm2 start on Linux — not on first build call. */
async function validateYtDlpAtStartup() {
  if (process.platform !== 'linux') return;

  const proxyOk = await _checkSocksProxy(YTDLP_SOCKS_HOST, YTDLP_SOCKS_PORT);
  if (!proxyOk) {
    throw new Error(
      `tailsocks offline (${YTDLP_SOCKS_HOST}:${YTDLP_SOCKS_PORT}). `
      + 'Start PM2 [Rete] Tailscale-Proxy (see SERVER_SETUP.md).'
    );
  }

  const ytdlpBin = fs.existsSync(YTDLP_BIN_HOST_PATH) ? YTDLP_BIN_HOST_PATH : 'yt-dlp (PATH)';
  log.info(`yt-dlp (build): host via socks5h://${YTDLP_SOCKS_HOST}:${YTDLP_SOCKS_PORT} bin=${ytdlpBin}`);
}

/** Container fs/pip probes — stay in sandbox (yt-dlp is not installed there). */
function _isYtDlpDiscoveryProbe(command) {
  const t = String(command || '').trim();
  if (!/\byt-dlp\b/i.test(t)) return false;
  return /\b(find|locate|grep|pip\s+(list|install)|apt\s+list|dpkg\s+-l|import\s+yt_dlp)\b/i.test(t)
    || /\bfind\b[^\n;|&]*yt-dlp/i.test(t)
    || /\becho\b[^\n;|&]*yt-dlp/i.test(t);
}

/** Run on VPS host (tailsocks) when the command actually invokes yt-dlp CLI. */
function _shouldExecYtDlpOnHost(command) {
  if (process.platform !== 'linux') return false;
  const t = String(command || '').trim();
  if (!/\byt-dlp\b/.test(t)) return false;
  if (_isYtDlpDiscoveryProbe(command)) return false;
  return true;
}

function _checkSocksProxy(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      try { socket.destroy(); } catch { /* */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Run yt-dlp on the VPS host (tailsocks @ 127.0.0.1:5040). Paths /workspace/…
 * are rewritten to the real build_workspace directory on disk.
 */
async function execYtDlpOnHost(workspaceId, command, timeoutMs) {
  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) throw new Error('Cannot resolve workspace directory');

  const proxyOk = await _checkSocksProxy(YTDLP_SOCKS_HOST, YTDLP_SOCKS_PORT);
  if (!proxyOk) {
    throw new Error(
      `tailsocks offline (${YTDLP_SOCKS_HOST}:${YTDLP_SOCKS_PORT}). `
      + 'Start PM2 [Rete] Tailscale-Proxy (see SERVER_SETUP.md).'
    );
  }

  const ytdlpBin = fs.existsSync(YTDLP_BIN_HOST_PATH) ? YTDLP_BIN_HOST_PATH : 'yt-dlp';
  const hostCmd = command.replace(/\/workspace\b/g, workspaceDir);
  const proxy = `socks5h://${YTDLP_SOCKS_HOST}:${YTDLP_SOCKS_PORT}`;
  const wrapper = `yt-dlp() { "${ytdlpBin}" --proxy "${proxy}" "$@"; }; `;
  const fullCmd = wrapper + hostCmd;

  const startedAt = Date.now();
  try {
    const hostEnv = { ...process.env };
    delete hostEnv.HTTP_PROXY;
    delete hostEnv.HTTPS_PROXY;
    delete hostEnv.http_proxy;
    delete hostEnv.https_proxy;
    const result = await execAsync(fullCmd, {
      cwd: workspaceDir,
      timeout: timeoutMs,
      shell: '/bin/bash',
      maxBuffer: 16 * 1024 * 1024,
      env: hostEnv,
    });
    return {
      rc: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const timedOut = Boolean(err.killed);
    return {
      rc: typeof err.code === 'number' ? err.code : (timedOut ? 124 : 1),
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  }
}

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

function _ensureWorkspaceWritable(workspaceDir) {
  if (process.platform !== 'linux') return;
  // When Node runs as root we just chown to the in-container UID 1000.
  if (process.getuid && process.getuid() === 0) {
    try { fs.chownSync(workspaceDir, 1000, 1000); }
    catch (err) { log.warn(`chown ${workspaceDir} -> 1000:1000 failed: ${err.message}`); }
    return;
  }
  // Non-root path: chmod 0777 / 0666 on the tree so UID 1000 can write.
  // Safe given the container is cap-dropped, network-isolated and
  // memory-capped.
  const walk = (p) => {
    try {
      const st = fs.statSync(p);
      fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
      if (st.isDirectory()) {
        for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
      }
    } catch (err) { log.warn(`chmod ${p} failed: ${err.message}`); }
  };
  walk(workspaceDir);
}

/**
 * Spawn a fresh container for `workspaceId`. The container runs an idle
 * sleep loop as PID 1 so we can attach via `docker exec` for individual
 * bash calls. No Jupyter/Python kernel here - the build agent does its
 * Python work server-side via xAI's code_interpreter tool.
 */
async function _spawnContainer(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) throw new Error('Cannot resolve workspace slug');

  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) throw new Error('Cannot ensure workspace directory');
  _ensureWorkspaceWritable(workspaceDir);

  const containerName = `gemix-bw-${slug}-${crypto.randomBytes(3).toString('hex')}`
    .toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63);

  const docker = _getDocker();
  const memBytes = SANDBOX_MEMORY_MB * 1024 * 1024;

  const binds = [
    `${workspaceDir}:/workspace:rw`,
    `${SKILLS_DIR}:/skills:ro`,
  ];

  const env = [
    'HOME=/tmp',
    'GEMIX_BUILD=1',
    // Outbound traffic from the sandbox goes through the egress proxy
    // (allowlisted, see sandbox/proxy/proxy.py). yt-dlp is host-side.
    `HTTP_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
    `HTTPS_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
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
    // The base sandbox image's ENTRYPOINT launches Jupyter Server, which we
    // don't need here (build agent does file ops via `docker exec` and
    // delegates Python work to xAI's server-side code_interpreter). Override
    // both Entrypoint and Cmd so the container becomes a quiet idle process.
    Entrypoint: [],
    Cmd: ['sleep', 'infinity'],
    User: '1000:1000',
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
    entry.lastUsedAt = Date.now();
    return entry;
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

/**
 * Run a shell command inside the container (one shot via `docker exec`).
 * The command is executed via `/bin/bash -lc`, so full shell syntax
 * (pipes, &&, ||, ;, redirection, subshells) is supported.
 *
 * `yt-dlp` CLI invocations are intercepted and run on the host (not discovery probes).
 *
 * @param {string} workspaceId
 * @param {string} command
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{rc:number,stdout:string,stderr:string,timedOut:boolean,durationMs:number}>}
 */
async function execBash(workspaceId, command, opts = {}) {
  const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 30000, 120000));

  if (_shouldExecYtDlpOnHost(command)) {
    return execYtDlpOnHost(workspaceId, command, timeoutMs);
  }

  const entry = await getOrCreate(workspaceId);
  entry.lastUsedAt = Date.now();

  const exec = await entry.container.exec({
    Cmd: ['/bin/bash', '-lc', command],
    AttachStdout: true,
    AttachStderr: true,
    User: '1000:1000',
    WorkingDir: '/workspace',
  });

  const startedAt = Date.now();
  const execStream = await exec.start({ hijack: true, stdin: false });

  const stdoutBuf = [];
  const stderrBuf = [];
  const stdoutStream = new stream.PassThrough();
  const stderrStream = new stream.PassThrough();
  stdoutStream.on('data', (chunk) => stdoutBuf.push(chunk));
  stderrStream.on('data', (chunk) => stderrBuf.push(chunk));

  // Demux Docker's multiplexed stream into stdout/stderr.
  entry.container.modem.demuxStream(execStream, stdoutStream, stderrStream);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { execStream.destroy(new Error('timeout')); } catch { /* ignore */ }
  }, timeoutMs);

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

  const durationMs = Date.now() - startedAt;
  return {
    rc,
    stdout: Buffer.concat(stdoutBuf).toString('utf-8'),
    stderr: Buffer.concat(stderrBuf).toString('utf-8'),
    timedOut,
    durationMs,
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
  execBash,
  shutdown,
  shutdownAll,
  cleanupOrphanBuildSandboxes,
  validateYtDlpAtStartup,
  // Diagnostics
  _pool,
};