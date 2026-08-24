// src/sandbox/workspaceRuntime.js
//
// The per-conversation container the main agent works in.
//
// One container per `workspaceId`, started lazily on first use and reused for
// as long as the user keeps interacting (containers idle past
// constants.SANDBOX_IDLE_TTL_MS are reaped). It stays alive between tool calls
// on purpose: a background process the agent starts in one `shell` call has to
// still be there in the next one, and re-creating a container per call would
// cost more than most calls do. The workspace's own 4h TTL is separate — the
// container is disposable, the files are not.
//
// Bind mounts, and the whole of what the model can see:
//
//   /workspace     rw   host build_workspace dir for this workspaceId
//   /attachments   ro   host projection of this conversation's files
//
// Nothing else is mounted and no credential is passed in. The container runs
// GemiX's own tools and whatever the model asks for, so it gets no bearer, no
// refresh token and no API key. Provider calls and their credentials remain
// host-owned and outside the model-controlled runtime.
//
// Notes:
//   - The base image ENTRYPOINT is overridden with `Cmd:['sleep','infinity']`
//     + `Entrypoint:[]` so the container is a quiet idle process to attach to.
//   - All egress (curl/wget/yt-dlp/pip-less downloads) goes through the egress
//     proxy, which forwards upstream via the residential SOCKS5 and fails
//     closed when that is unavailable.

import crypto from 'crypto';
import stream from 'stream';

import constants from '../config/constants.js';
import envConfig from '../config/env.js';

import { workspaceIdToSlug } from '../utils/workspaceId.js';
import {
  ensureAttachmentsDir,
  ensureWorkspace,
  ensureWorkspaceWritable,
  sandboxUserString
} from './workspaceFs.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WorkspaceRuntime');

const SANDBOX_IMAGE = envConfig.GEMIX_SANDBOX_IMAGE;
const SANDBOX_NETWORK = envConfig.GEMIX_SANDBOX_NETWORK;
const PROXY_HOSTNAME = envConfig.GEMIX_SANDBOX_PROXY_HOST;
const PROXY_PORT = envConfig.GEMIX_SANDBOX_PROXY_PORT;
const PROXY_URL = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;

/** Map<workspaceId, WorkspaceContainerEntry> */
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
 * The environment every exec inherits. Docker's ExecConfig.Env replaces the
 * container environment entirely when set, so the proxy and HOME are repeated
 * per exec rather than relied on from the container.
 */
function containerEnv() {
  return [
    'HOME=/var/lib/gemix-workspace',
    // All outbound traffic goes through the egress proxy → residential SOCKS5.
    // Fail-closed when the upstream is down.
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    'NO_PROXY=localhost,127.0.0.1'
  ];
}

/**
 * Spawn a fresh container for `workspaceId`. Idle `sleep infinity` PID 1;
 * tools attach via docker exec.
 */
async function _spawnContainer(workspaceId) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) throw new Error('Cannot resolve workspace slug');

  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) throw new Error('Cannot ensure workspace directory');
  // Docker refuses to start when a bind source is missing, so the projection
  // root has to exist even before anything is projected into it.
  const attachmentsDir = ensureAttachmentsDir(workspaceId);
  if (!attachmentsDir) throw new Error('Cannot ensure attachments directory');
  ensureWorkspaceWritable(workspaceId);

  const containerName = `gemix-ws-${slug}-${crypto.randomBytes(3).toString('hex')}`
    .toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63);

  const docker = await _getDocker();
  const memBytes = constants.SANDBOX_MEMORY_MB * 1024 * 1024;

  const binds = [
    `${workspaceDir}:/workspace:rw`,
    `${attachmentsDir}:/attachments:ro`
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
    Hostname: 'workspace',
    // Override image defaults so the container is a quiet idle process we
    // attach to via docker exec.
    Entrypoint: [],
    Cmd: ['sleep', 'infinity'],
    User: sandboxUserString(),
    Env: containerEnv(),
    HostConfig: hostConfig,
    Labels: {
      'gemix.kind': 'workspace-runtime',
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
      throw new Error(`workspace container boot failed for ${workspaceId}`);
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
    log.warn(`Stale workspace container for ${workspaceId}, recreating`);
    await _killEntry(entry).catch(err => log.warn(`stale purge: ${err.message}`));
    _pool.delete(workspaceId);
  }

  // Another concurrent caller may have started boot while we were checking.
  entry = _pool.get(workspaceId);
  if (entry && entry._bootPromise) {
    await entry._bootPromise;
    const ready = _pool.get(workspaceId);
    if (!ready || !ready.container) {
      throw new Error(`workspace container boot failed for ${workspaceId}`);
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
    log.info(`workspace container ready workspace=${workspaceId} container=${fresh.containerName}`);
    return fresh;
  } catch (err) {
    _pool.delete(workspaceId);
    throw err;
  }
}

function _capBufferChunks(chunks, maxBytes = constants.WORKSPACE_OUTPUT_MAX_BYTES) {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total <= maxBytes) return { text: Buffer.concat(chunks).toString('utf-8'), truncated: false };
  // Keep the tail (most relevant for errors / final output).
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
  return { text: out.toString('utf-8'), truncated: true };
}

/**
 * Argv for one command inside the workspace, wrapped in `timeout` so a runaway
 * process dies in the container rather than only losing its stream on the host.
 *
 * Pure and Docker-free so the shaping stays testable.
 *
 * @param {object} opts
 * @param {string[]|string} opts.command - argv, or a shell line run with bash -lc
 * @param {number} [opts.timeoutMs]
 * @returns {{ cmd: string[], timeoutMs: number }}
 */
function buildExecSpec({ command, timeoutMs } = {}) {
  const requested = Number(timeoutMs);
  const timeout = Math.max(
    1_000,
    Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : constants.SHELL_TIMEOUT_DEFAULT_MS,
      constants.SHELL_TIMEOUT_MAX_MS
    )
  );
  let argv;
  if (Array.isArray(command)) {
    argv = command.filter(a => typeof a === 'string');
    if (argv.length === 0) throw new Error('buildExecSpec: empty command');
  } else if (typeof command === 'string' && command.trim()) {
    argv = ['/bin/bash', '-lc', command];
  } else {
    throw new Error('buildExecSpec: missing command');
  }
  const timeoutSec = Math.max(1, Math.ceil(timeout / 1000));
  return {
    cmd: ['timeout', '--signal=KILL', `${timeoutSec}s`, ...argv],
    timeoutMs: timeout
  };
}

/**
 * Run one command inside the workspace container and capture its output.
 *
 * `input` is how file content reaches the container: piping it on stdin keeps
 * the bytes out of argv, which has a hard size limit and would put user content
 * in the process table.
 *
 * @param {string} workspaceId
 * @param {object} opts
 * @param {string[]|string} opts.command
 * @param {Buffer|string} [opts.input] - written to the command's stdin
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.workingDir] - defaults to /workspace
 * @returns {Promise<{rc:number,stdout:string,stderr:string,truncated:boolean,timedOut:boolean,durationMs:number}>}
 */
async function execInWorkspace(workspaceId, opts = {}) {
  const { cmd, timeoutMs } = buildExecSpec(opts);
  const hasInput = opts.input !== undefined && opts.input !== null;
  const entry = await getOrCreate(workspaceId);
  entry.lastUsedAt = Date.now();

  const exec = await entry.container.exec({
    Cmd: cmd,
    AttachStdin: hasInput,
    AttachStdout: true,
    AttachStderr: true,
    User: sandboxUserString(),
    WorkingDir: opts.workingDir || '/workspace',
    Env: containerEnv()
  });

  const startedAt = Date.now();
  const execStream = await exec.start({ hijack: true, stdin: hasInput });
  if (hasInput) {
    execStream.write(Buffer.isBuffer(opts.input) ? opts.input : Buffer.from(String(opts.input), 'utf-8'));
    // The command reads until EOF, so the half-close is what makes it finish.
    execStream.end();
  }

  const stdoutBuf = [];
  const stderrBuf = [];
  const stdoutStream = new stream.PassThrough();
  const stderrStream = new stream.PassThrough();
  stdoutStream.on('data', (chunk) => stdoutBuf.push(chunk));
  stderrStream.on('data', (chunk) => stderrBuf.push(chunk));
  entry.container.modem.demuxStream(execStream, stdoutStream, stderrStream);

  let timedOut = false;
  // Host-side ceiling slightly above in-container `timeout` so stream teardown
  // is only a backstop for a container that stopped answering entirely.
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
  // GNU timeout uses 124 on timeout; the SIGKILL path reports 137.
  if (rc === 124 || rc === 137) timedOut = true;

  const stdout = _capBufferChunks(stdoutBuf);
  const stderr = _capBufferChunks(stderrBuf);
  const durationMs = Date.now() - startedAt;
  ensureWorkspaceWritable(workspaceId);
  entry.lastUsedAt = Date.now();
  return {
    rc,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    timedOut,
    durationMs
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
  log.info(`workspace container shut down workspace=${workspaceId}`);
}

async function shutdownAll() {
  const entries = [..._pool.values()];
  _pool.clear();
  await Promise.all(entries.map(e => _killEntry(e).catch(err => log.warn(`shutdownAll: ${err.message}`))));
}

/**
 * Best-effort cleanup of dangling workspace containers from previous runs.
 * Matches the current `gemix-ws-` prefix and the `gemix-bw-` one older builds
 * used, plus either generation's label. Called on startup.
 */
async function cleanupOrphanContainers() {
  let docker;
  try { docker = await _getDocker(); }
  catch (err) { log.debug(`Orphan cleanup skipped: ${err.message}`); return; }

  try {
    const containers = await docker.listContainers({ all: true });
    const orphans = containers.filter(c =>
      c.Names.some(n => n.startsWith('/gemix-ws-') || n.startsWith('/gemix-bw-'))
      || (c.Labels && (c.Labels['gemix.kind'] === 'workspace-runtime' || c.Labels['gemix.kind'] === 'build-workspace'))
    );
    if (orphans.length === 0) return;

    log.info(`Found ${orphans.length} orphan workspace container(s). Cleaning up...`);
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
    log.error(`Orphan workspace container cleanup failed: ${err.message}`);
  }
}

// -- Idle reaper -----------------------------------------------------------
const _reaper = setInterval(() => {
  const now = Date.now();
  for (const [workspaceId, entry] of _pool.entries()) {
    if (!entry.lastUsedAt) continue;
    if (now - entry.lastUsedAt > constants.SANDBOX_IDLE_TTL_MS) {
      log.info(`reaping idle workspace container ${workspaceId} (idle ${(now - entry.lastUsedAt) / 1000 | 0}s)`);
      _pool.delete(workspaceId);
      _killEntry(entry).catch(err => log.warn(`reap kill failed: ${err.message}`));
    }
  }
}, 60_000);
_reaper.unref();

cleanupOrphanContainers().catch(err => log.error(`Background orphan cleanup failed: ${err.message}`));

export default {
  execInWorkspace,
  buildExecSpec,
  containerEnv,
  shutdown,
  shutdownAll
};
