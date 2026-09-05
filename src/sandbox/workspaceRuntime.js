// src/sandbox/workspaceRuntime.js
//
// The per-conversation container the main agent works in.
//
// One container per `workspaceId`, started lazily on first use and reused while
// container commands keep it active. It stays alive between nearby tool calls
// so a background process started by `shell` can be inspected later. Once no
// container command has run for constants.SANDBOX_IDLE_TTL_MS, the whole
// container and every process in it are reaped. The workspace's own 4h TTL is
// separate — the container is disposable, the files are not.
//
// Bind mounts, and the whole of what the model can see:
//
//   /workspace     rw   host build_workspace dir for this workspaceId
//   /attachments   ro   host projection of this conversation's files
//   /skills        ro   the deployment's shared skill library, on the platforms
//                       that offer it (see config/platformCapabilities.js)
//
// Nothing else is mounted and no credential is passed in. The container runs
// GemiX's own tools and whatever the model asks for, so it gets no bearer, no
// refresh token and no API key. Provider calls and their credentials remain
// host-owned and outside the model-controlled runtime.
//
// Notes:
//   - PID 1 is a quota monitor; commands still attach through Docker exec.
//   - All egress (curl/wget/yt-dlp/pip-less downloads) goes through the egress
//     proxy, the only container on this network with a route out, and it
//     refuses every destination that is not globally routable.

import crypto from 'crypto';
import stream from 'stream';

import constants from '../config/constants.js';
import envConfig from '../config/env.js';

import { workspaceIdToSlug } from '../utils/workspaceId.js';
import {
  ensureAttachmentsDir,
  ensureSkillsDir,
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
const WORKSPACE_QUOTA_BYTES = constants.WORKSPACE_QUOTA_MB * 1024 * 1024;

/**
 * Map<workspaceId, Promise<WorkspaceContainerEntry>>.
 *
 * The entry is the boot promise itself, not the container: a caller that
 * arrives mid-boot awaits the same promise as the one that started it, so
 * there is a single place where "is it ready" is answered.
 */
const _pool = new Map();
let _shuttingDown = false;

/** Error code a caller matches to tell "no slot free" from a real failure. */
const SANDBOX_BUSY_CODE = 'ESANDBOXBUSY';

/**
 * Whether one request may proceed to a container.
 *
 * The cap only ever refuses a NEW container. `pooled` is what makes that safe:
 * a chat already holding one keeps it whatever the count says, so a session is
 * never cut off half way through - and reclaiming a slot whose container died
 * does not add to the total either. The ceiling applies equally to every chat.
 *
 * Pure on purpose: this is the rule, and it stays testable without Docker.
 *
 * @param {object} req
 * @param {boolean} req.pooled - this workspace already has an entry in the pool
 * @param {number} req.activeCount - entries currently pooled
 * @returns {boolean}
 */
function admitWorkspaceRequest({ pooled, activeCount }) {
  if (pooled) return true;
  return activeCount < constants.SANDBOX_MAX_CONTAINERS;
}

function _boundedName(prefix, identity, nonce, maxLength = 63) {
  const safePrefix = String(prefix || 'gemix').toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  const safeNonce = String(nonce || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hash = crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 12);
  const suffix = `${hash}-${safeNonce}`;
  return `${safePrefix.slice(0, Math.max(1, maxLength - suffix.length - 1))}-${suffix}`;
}

function workspaceContainerName(workspaceId, nonce = crypto.randomBytes(3).toString('hex')) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) throw new Error('Cannot resolve workspace slug');
  return _boundedName(`gemix-ws-${slug}`, workspaceId, nonce);
}

function workspaceNetworkName(workspaceId, nonce = crypto.randomBytes(3).toString('hex')) {
  return _boundedName(`${SANDBOX_NETWORK}-ws`, workspaceId, nonce);
}

function workspaceNetworkCreateOptions(workspaceId, networkName) {
  return {
    Name: networkName,
    Internal: true,
    Labels: {
      'gemix.kind': 'workspace-network',
      'gemix.workspaceId': workspaceId,
      'gemix.ownerPid': String(process.pid)
    }
  };
}

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
    // All outbound traffic goes through the egress proxy, which is what keeps
    // the sandbox off the host's LAN.
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    'NO_PROXY=localhost,127.0.0.1'
  ];
}

/**
 * Spawn a fresh container for `workspaceId`. Its quota monitor is PID 1 and
 * tools attach through docker exec.
 *
 * `mountSkills` decides whether the library is bound in at all. A workspace
 * belongs to exactly one chat, so the answer never changes for a given id and
 * the pooled container can be reused without rechecking it. The caller passes
 * what its platform allows; nothing here can derive it, and a missing answer
 * means no mount, so a new caller cannot get it by accident.
 */
async function _spawnContainer(workspaceId, { mountSkills = false } = {}) {
  const slug = workspaceIdToSlug(workspaceId);
  if (!slug) throw new Error('Cannot resolve workspace slug');

  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) throw new Error('Cannot ensure workspace directory');
  // Docker refuses to start when a bind source is missing, so the projection
  // root has to exist even before anything is projected into it.
  const attachmentsDir = ensureAttachmentsDir(workspaceId);
  if (!attachmentsDir) throw new Error('Cannot ensure attachments directory');
  let skillsDir = null;
  if (mountSkills) {
    skillsDir = ensureSkillsDir();
    if (!skillsDir) throw new Error('Cannot ensure skills directory');
  }
  ensureWorkspaceWritable(workspaceId);

  const nonce = crypto.randomBytes(3).toString('hex');
  const containerName = workspaceContainerName(workspaceId, nonce);
  const networkName = workspaceNetworkName(workspaceId, nonce);

  const docker = await _getDocker();
  const memBytes = constants.SANDBOX_MEMORY_MB * 1024 * 1024;

  const binds = [
    `${workspaceDir}:/workspace:rw`,
    `${attachmentsDir}:/attachments:ro`
  ];
  if (skillsDir) binds.push(`${skillsDir}:/skills:ro`);

  const hostConfig = {
    NetworkMode: networkName,
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
    Entrypoint: [],
    Cmd: [
      'python',
      '/opt/sandbox/quota_guard.py',
      `/workspace=${WORKSPACE_QUOTA_BYTES}:${constants.WORKSPACE_MAX_ENTRIES}`
    ],
    User: sandboxUserString(),
    Env: containerEnv(),
    HostConfig: hostConfig,
    Labels: {
      'gemix.kind': 'workspace-runtime',
      'gemix.workspaceId': workspaceId,
      'gemix.ownerPid': String(process.pid)
    }
  };

  let network;
  const proxyContainer = docker.getContainer(PROXY_HOSTNAME);
  let container;
  try {
    await proxyContainer.inspect();
    network = await docker.createNetwork(workspaceNetworkCreateOptions(workspaceId, networkName));
    await network.connect({
      Container: proxyContainer.id,
      EndpointConfig: { Aliases: [PROXY_HOSTNAME] }
    });
    container = await docker.createContainer(createOpts);
    await container.start();
  } catch (err) {
    if (container) {
      try { await container.remove({ force: true }); } catch { /* not created or already removed */ }
    }
    if (network) {
      try { await network.disconnect({ Container: proxyContainer.id, Force: true }); } catch { /* not connected */ }
      try { await network.remove(); } catch { /* best effort */ }
    }
    throw err;
  }

  return {
    workspaceId,
    container,
    containerId: container.id,
    containerName,
    network,
    networkName,
    proxyContainer,
    lastUsedAt: Date.now()
  };
}

/**
 * Why a command came back as SIGKILL, asked of Docker rather than guessed.
 *
 * The cgroup records an OOM kill on the container itself, and a container whose
 * PID 1 exits takes every exec down with it - which AutoRemove then collects,
 * so a probe that finds nothing left is the same answer as one that finds it
 * stopped. Null means the container is still up and something inside it, the
 * quota monitor above all, did the killing.
 *
 * @returns {Promise<'oom'|'container-stopped'|null>}
 */
async function _killCause(entry) {
  try {
    const state = (await entry.container.inspect()).State || {};
    if (state.OOMKilled) return 'oom';
    return state.Running ? null : 'container-stopped';
  } catch {
    return 'container-stopped';
  }
}

/** Whether Docker still reports this entry's container as running. */
async function _isAlive(entry) {
  try { return Boolean((await entry.container.inspect()).State?.Running); }
  catch { return false; }
}

/** Reserve a pool generation synchronously before its asynchronous work starts. */
function _replacePoolGeneration(pool, key, expected, factory) {
  if (pool.get(key) !== expected) return pool.get(key) || null;
  const generation = Promise.resolve().then(factory).catch(error => {
    if (pool.get(key) === generation) {
      if (expected) pool.set(key, expected);
      else pool.delete(key);
    }
    throw error;
  });
  pool.set(key, generation);
  return generation;
}

function _bootGeneration(workspaceId, opts, staleEntry = null) {
  return async () => {
    if (staleEntry) {
      log.warn(`Stale workspace container for ${workspaceId}, recreating`);
      await _killEntry(staleEntry);
    }
    const entry = await _spawnContainer(workspaceId, opts);
    entry.lastUsedAt = Date.now();
    log.info(`workspace container ready workspace=${workspaceId} container=${entry.containerName}`);
    return entry;
  };
}

/**
 * Public API: get (or spawn) the running container for this workspace.
 *
 * Concurrent callers share one boot: whoever finds a pooled promise awaits it
 * and then checks liveness, and a container Docker no longer reports as running
 * is purged and replaced.
 *
 * Opening a new container is subject to constants.SANDBOX_MAX_CONTAINERS: the
 * host shares its RAM with three other bots, so past the ceiling a chat that
 * has no container yet is refused with SANDBOX_BUSY_CODE rather than served at
 * everyone else's expense. Nothing is created on that path.
 *
 * @param {string} workspaceId
 */
async function getOrCreate(workspaceId, opts = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (_shuttingDown) throw new Error('Sandbox runtime is shutting down.');

  while (true) {
    let pending = _pool.get(workspaceId);
    if (!pending) {
      if (!admitWorkspaceRequest({ pooled: false, activeCount: _pool.size })) {
        log.warn(
          `sandbox at capacity (${_pool.size}/${constants.SANDBOX_MAX_CONTAINERS}): `
          + `no new container for ${workspaceId}`
        );
        const err = new Error('Every sandbox slot is in use.');
        err.code = SANDBOX_BUSY_CODE;
        throw err;
      }
      pending = _replacePoolGeneration(
        _pool,
        workspaceId,
        undefined,
        _bootGeneration(workspaceId, opts)
      );
      if (!pending) continue;
    }

    let entry;
    try {
      entry = await pending;
    } catch (err) {
      if (_pool.get(workspaceId) === pending) _pool.delete(workspaceId);
      throw err;
    }
    if (_pool.get(workspaceId) !== pending) continue;
    if (entry && await _isAlive(entry)) {
      if (_pool.get(workspaceId) !== pending) continue;
      entry.lastUsedAt = Date.now();
      return entry;
    }

    const replacement = _replacePoolGeneration(
      _pool,
      workspaceId,
      pending,
      _bootGeneration(workspaceId, opts, entry)
    );
    if (!replacement || replacement === pending) continue;
    try {
      return await replacement;
    } catch (err) {
      if (_pool.get(workspaceId) === replacement) _pool.delete(workspaceId);
      throw err;
    }
  }
}

class SharedOutputTail {
  constructor(maxBytes = constants.WORKSPACE_OUTPUT_MAX_BYTES) {
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
    this.segments = [];
    this.retainedBytes = 0;
    this.droppedBytes = 0;
  }

  append(streamName, rawChunk) {
    const chunk = Buffer.from(rawChunk);
    if (chunk.length >= this.maxBytes) {
      this.droppedBytes += this.retainedBytes + chunk.length - this.maxBytes;
      this.segments = [{ streamName, chunk: chunk.subarray(chunk.length - this.maxBytes) }];
      this.retainedBytes = this.maxBytes;
      return;
    }
    this.segments.push({ streamName, chunk });
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes && this.segments.length > 0) {
      const overflow = this.retainedBytes - this.maxBytes;
      const first = this.segments[0];
      if (first.chunk.length <= overflow) {
        this.segments.shift();
        this.retainedBytes -= first.chunk.length;
        this.droppedBytes += first.chunk.length;
      } else {
        first.chunk = first.chunk.subarray(overflow);
        this.retainedBytes -= overflow;
        this.droppedBytes += overflow;
      }
    }
  }

  result() {
    const chunks = { stdout: [], stderr: [] };
    for (const segment of this.segments) chunks[segment.streamName].push(segment.chunk);
    return {
      stdout: Buffer.concat(chunks.stdout).toString('utf-8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf-8'),
      truncated: this.droppedBytes > 0,
      droppedBytes: this.droppedBytes
    };
  }
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
    if (command.length === 0) throw new Error('buildExecSpec: empty command');
    // A non-string entry is a caller bug: dropping it would run a command
    // nobody asked for, so it is refused instead.
    if (command.some(a => typeof a !== 'string')) {
      throw new Error('buildExecSpec: every argv entry must be a string');
    }
    argv = command;
  } else if (typeof command === 'string' && command.trim()) {
    argv = ['/bin/bash', '-lc', command];
  } else {
    throw new Error('buildExecSpec: missing command');
  }
  argv = ['python', '/opt/sandbox/quota_exec.py', String(WORKSPACE_QUOTA_BYTES), ...argv];
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
 * @returns {Promise<{rc:number,stdout:string,stderr:string,truncated:boolean,droppedBytes:number,timedOut:boolean,
 *   killCause:'oom'|'container-stopped'|null,durationMs:number}>}
 */
async function execInWorkspace(workspaceId, opts = {}) {
  const { cmd, timeoutMs } = buildExecSpec(opts);
  const hasInput = opts.input !== undefined && opts.input !== null;
  const entry = await getOrCreate(workspaceId, { mountSkills: Boolean(opts.mountSkills) });
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

  const output = new SharedOutputTail();
  const stdoutStream = new stream.PassThrough();
  const stderrStream = new stream.PassThrough();
  stdoutStream.on('data', (chunk) => output.append('stdout', chunk));
  stderrStream.on('data', (chunk) => output.append('stderr', chunk));
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
  // GNU timeout uses 124, or 137 when its final SIGKILL fired. Other sandbox
  // enforcement (notably the quota monitor) can also produce 137, so only
  // classify that code as a timeout when it arrived at the configured edge.
  if (rc === 124 || (rc === 137 && Date.now() - startedAt >= timeoutMs - 1_000)) timedOut = true;

  // SIGKILL leaves the command nothing to report, so the reason has to come
  // from Docker before the caller can say anything useful about it.
  const killCause = rc === 137 && !timedOut ? await _killCause(entry) : null;
  if (killCause === 'container-stopped') {
    log.warn(
      `workspace container stopped mid-command workspace=${workspaceId} container=${entry.containerName}: `
      + 'its PID 1 exited. Check the sandbox image is not older than this runtime and rebuild it, '
      + 'then the host for memory pressure.'
    );
  } else if (killCause === 'oom') {
    log.warn(
      `workspace command hit the ${constants.SANDBOX_MEMORY_MB} MB memory cap `
      + `workspace=${workspaceId} container=${entry.containerName}`
    );
  }

  const captured = output.result();
  const durationMs = Date.now() - startedAt;
  ensureWorkspaceWritable(workspaceId);
  entry.lastUsedAt = Date.now();
  return {
    rc,
    stdout: captured.stdout,
    stderr: captured.stderr,
    truncated: captured.truncated,
    droppedBytes: captured.droppedBytes,
    timedOut,
    killCause,
    durationMs
  };
}

function _resourceAlreadyAbsent(err) {
  const status = Number(err?.statusCode || err?.status);
  return status === 304
    || status === 404
    || /(?:already stopped|not found|no such|not connected)/i.test(String(err?.message || ''));
}

async function _killEntry(entry) {
  if (!entry) return;
  const failures = [];
  const attempt = async (label, operation) => {
    try { await operation(); }
    catch (err) {
      if (!_resourceAlreadyAbsent(err)) failures.push(new Error(`${label}: ${err.message}`, { cause: err }));
    }
  };
  if (entry.container) {
    await attempt('container stop', () => entry.container.stop({ t: 2 }));
    await attempt('container removal', () => entry.container.remove({ force: true }));
  }
  if (entry.network) {
    await attempt('proxy disconnect', () => entry.network.disconnect({
      Container: entry.proxyContainer?.id || PROXY_HOSTNAME,
      Force: true
    }));
    await attempt('network removal', () => entry.network.remove());
  }
  if (failures.length > 0) {
    const error = new AggregateError(failures, 'Could not fully remove the workspace runtime resources.');
    error.workspaceEntry = entry;
    throw error;
  }
}

async function shutdown(workspaceId) {
  const pending = _pool.get(workspaceId);
  if (!pending) return;
  const closing = _replacePoolGeneration(_pool, workspaceId, pending, async () => {
    let entry;
    try { entry = await pending; }
    catch { return null; }
    await _killEntry(entry);
    return null;
  });
  if (!closing) return;
  try {
    await closing;
  } catch (err) {
    if (_pool.get(workspaceId) === closing && err?.workspaceEntry) {
      _pool.set(workspaceId, Promise.resolve(err.workspaceEntry));
    }
    throw err;
  }
  if (_pool.get(workspaceId) === closing) _pool.delete(workspaceId);
  log.info(`workspace container shut down workspace=${workspaceId}`);
}

async function shutdownAll() {
  _shuttingDown = true;
  const closing = [];
  for (const [workspaceId, pending] of [..._pool.entries()]) {
    const generation = _replacePoolGeneration(_pool, workspaceId, pending, async () => {
      try { await _killEntry(await pending); }
      catch (err) { log.warn(`shutdownAll: ${err.message}`); }
      return null;
    });
    if (generation) closing.push([workspaceId, generation]);
  }
  await Promise.all(closing.map(([, generation]) => generation));
  for (const [workspaceId, generation] of closing) {
    if (_pool.get(workspaceId) === generation) _pool.delete(workspaceId);
  }
}

/**
 * Whether a process id still names a live host process. EPERM means the
 * process exists but this account cannot signal it, which is still alive.
 */
function _pidIsAlive(rawPid) {
  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function _ownedResourceIsOrphan(labels) {
  const ownerPid = labels?.['gemix.ownerPid'];
  return !ownerPid || ownerPid === String(process.pid) || !_pidIsAlive(ownerPid);
}

/**
 * Best-effort startup cleanup of dangling workspace resources. Legacy entries
 * without an owner are removable; resources owned by another live GemiX
 * process are left untouched.
 */
async function cleanupOrphanContainers() {
  let docker;
  try { docker = await _getDocker(); }
  catch (err) { log.debug(`Orphan cleanup skipped: ${err.message}`); return; }

  try {
    const containers = await docker.listContainers({ all: true });
    const orphans = containers.filter((c) => {
      const isWorkspace = c.Names.some(n => n.startsWith('/gemix-ws-'))
        || c.Labels?.['gemix.kind'] === 'workspace-runtime';
      return isWorkspace && _ownedResourceIsOrphan(c.Labels);
    });
    if (orphans.length > 0) {
      log.info(`Found ${orphans.length} orphan workspace container(s). Cleaning up...`);
    }
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

    const networks = (await docker.listNetworks({ filters: { label: ['gemix.kind=workspace-network'] } }))
      .filter(info => _ownedResourceIsOrphan(info.Labels));
    for (const networkInfo of networks) {
      try {
        const network = docker.getNetwork(networkInfo.Id);
        const inspected = await network.inspect();
        for (const containerId of Object.keys(inspected.Containers || {})) {
          await network.disconnect({ Container: containerId, Force: true }).catch(() => {});
        }
        await network.remove();
        log.info(`Cleaned up orphan workspace network ${networkInfo.Name}`);
      } catch (err) {
        log.warn(`Failed to cleanup workspace network ${networkInfo.Name}: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`Orphan workspace container cleanup failed: ${err.message}`);
  }
}

// -- Background lifecycle ---------------------------------------------------

function _reapIdleContainers() {
  for (const [workspaceId, pending] of [..._pool.entries()]) {
    pending.then((entry) => {
      if (!entry?.lastUsedAt) return null;
      // Re-read the clock after the await: the container may have been used
      // again while this tick was resolving.
      const idleMs = Date.now() - entry.lastUsedAt;
      if (idleMs <= constants.SANDBOX_IDLE_TTL_MS) return null;
      // Leave it alone if a replacement took its place in the pool.
      if (_pool.get(workspaceId) !== pending) return null;
      log.info(`reaping idle workspace container ${workspaceId} (idle ${idleMs / 1000 | 0}s)`);
      const closing = _replacePoolGeneration(_pool, workspaceId, pending, async () => {
        await _killEntry(entry);
        return null;
      });
      if (!closing || closing === pending) return null;
      return closing.finally(() => {
        if (_pool.get(workspaceId) === closing) _pool.delete(workspaceId);
      });
    }).catch(err => log.warn(`reap failed for ${workspaceId}: ${err.message}`));
  }
}

let _reaper = null;

/** Start the idle reaper and one-shot orphan cleanup. Idempotent. */
function init() {
  if (_reaper) return;
  _reaper = setInterval(_reapIdleContainers, 60_000);
  _reaper.unref();
  cleanupOrphanContainers().catch(err => log.error(`Background orphan cleanup failed: ${err.message}`));
}

export {
  SharedOutputTail,
  _ownedResourceIsOrphan,
  _replacePoolGeneration,
  admitWorkspaceRequest,
  SANDBOX_BUSY_CODE
};

export default {
  init,
  execInWorkspace,
  buildExecSpec,
  containerEnv,
  workspaceContainerName,
  workspaceNetworkName,
  workspaceNetworkCreateOptions,
  shutdown,
  shutdownAll
};
