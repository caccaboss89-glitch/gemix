// src/sandbox/sandboxManager.js
// Lifecycle manager for the GemiX Python sandbox containers.
//
// One container per (storageId, projectName). Lazy-started on first use,
// reused for the lifetime of the project session, and reaped after
// SANDBOX_IDLE_TTL_MS of inactivity. The manager keeps the Jupyter kernel
// (PythonKernel) attached to each container so successive code_execution
// calls share a single Python REPL state.
//
// Hard requirements at runtime:
//   - dockerd reachable (default unix socket; override with DOCKER_HOST env).
//   - Two docker networks already exist:
//       gemix_sandbox_net  (internal)   ← sandboxes attach here
//       gemix_sandbox_egress (bridge)   ← proxy attaches here
//   - The proxy container is named "gemix-sandbox-proxy" and is reachable
//     from gemix_sandbox_net (same name resolves via docker DNS).
//   - Image "gemix-sandbox:latest" is built (see sandbox/Dockerfile).
//
// Failure mode for fresh installs: getOrCreate() throws a clear error pointing
// at sandbox/README.md. Callers (codeExecution tool) surface that to the AI.

const crypto = require('crypto');
const fs = require('fs');

const {
  SANDBOX_MEMORY_MB,
  SANDBOX_IDLE_TTL_MS,
} = require('../config/constants');
const {
  resolveStorageId,
  getProjectRoot,
  getScratchDir,
  getHistoryDir,
  getPermanentDir,
  getSearchedImagesDir,
  ensureUserSkeleton,
  ensureProjectSkeleton,
} = require('../utils/userPaths');
const { createLogger } = require('../utils/logger');
const { PythonKernel } = require('./pythonKernel');

const log = createLogger('SandboxManager');

const SANDBOX_IMAGE = process.env.GEMIX_SANDBOX_IMAGE || 'gemix-sandbox:latest';
const SANDBOX_NETWORK = process.env.GEMIX_SANDBOX_NETWORK || 'gemix_sandbox_net';
const PROXY_HOSTNAME = process.env.GEMIX_SANDBOX_PROXY_HOST || 'gemix-sandbox-proxy';
const PROXY_PORT = process.env.GEMIX_SANDBOX_PROXY_PORT || '8080';

// Map<key, SandboxEntry>
const _pool = new Map();

// Single Docker client instance, lazy-required so unit tests of pure helpers
// can run without dockerode installed.
let _docker = null;
function _getDocker() {
  if (_docker) return _docker;
  let Docker;
  try { Docker = require('dockerode'); }
  catch (e) {
    throw new Error(
      'dockerode is not installed. Run `npm install` to fetch the new dependencies (Phase C.3).'
    );
  }
  _docker = new Docker();
  return _docker;
}

/**
 * Build the pool key for a (user, project) tuple.
 */
function _poolKey(storageId, projectName) {
  return `${storageId}::${projectName}`;
}

/**
 * Allocate a free TCP port on the host loopback. Used for kernel discovery.
 * NOTE: kernels only listen on the internal network, so this port is published
 * back to localhost via docker -p so Node can connect to ws://127.0.0.1:<port>.
 */
function _randomPort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Set ownership of project + readonly mount points to UID 1000 (sandbox user
 * inside the container). No-op on non-root or non-Linux platforms.
 */
function _ensureOwnership(targetPath) {
  if (process.platform !== 'linux') return;
  if (process.getuid && process.getuid() !== 0) return;
  try {
    fs.chownSync(targetPath, 1000, 1000);
  } catch (err) {
    log.warn(`chown ${targetPath} -> 1000:1000 failed: ${err.message}`);
  }
}

/**
 * Create + start a fresh sandbox container for (storageId, projectName).
 * Returns the entry to be inserted into the pool. The kernel inside is NOT
 * started here — caller invokes entry.kernel.start() after the container
 * is healthy.
 */
async function _spawnContainer(userCtx, projectName) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) throw new Error('Cannot resolve storageId');
  const isScratch = projectName === '_scratch_';
  const projectDir = isScratch 
    ? getScratchDir(userCtx) 
    : getProjectRoot(userCtx, projectName);
  if (!projectDir) throw new Error('Cannot resolve project/scratch directory');
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  if (!isScratch) {
    ensureProjectSkeleton(userCtx, projectName);
  }

  // Read-only mounts: chat history, permanent storage, searched images so the AI can
  // reference them in scripts.
  const historyDir = getHistoryDir(userCtx);
  const permanentDir = getPermanentDir(userCtx);
  const searchedDir = getSearchedImagesDir(userCtx);
  const skillsDir = require('../utils/userPaths').SKILLS_DIR;

  for (const p of [projectDir, historyDir, permanentDir, searchedDir]) {
    if (fs.existsSync(p)) _ensureOwnership(p);
  }

  const token = crypto.randomBytes(24).toString('hex');
  const hostPort = await _randomPort();
  const containerName = `gemix-sb-${storageId}-${projectName}-${crypto.randomBytes(3).toString('hex')}`
    .toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63);

  const docker = _getDocker();
  const memBytes = SANDBOX_MEMORY_MB * 1024 * 1024;

  // dockerode expects HostConfig in camelCase; using the .NET-style names
  // would silently no-op.
  const createOpts = {
    name: containerName,
    Image: SANDBOX_IMAGE,
    Hostname: 'sandbox',
    Env: [
      `SANDBOX_TOKEN=${token}`,
      `HTTP_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
      `HTTPS_PROXY=http://${PROXY_HOSTNAME}:${PROXY_PORT}`,
      'NO_PROXY=localhost,127.0.0.1',
      'HOME=/tmp', // Ensure home is writable even if UID changes
    ],
    User: process.getuid ? `${process.getuid()}:${process.getgid()}` : '1000:1000',
    ExposedPorts: { '8888/tcp': {} },
    HostConfig: {
      NetworkMode: SANDBOX_NETWORK,
      AutoRemove: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: 200,
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: 1_000_000_000, // 1.0 CPU
      Tmpfs: { '/tmp': 'size=256m' },
      PortBindings: {
        '8888/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }],
      },
      Binds: [
        `${projectDir}:/workspace:rw`,
        `${historyDir}:/readonly/history:ro`,
        `${permanentDir}:/readonly/permanent:ro`,
        `${searchedDir}:/readonly/searched_images:ro`,
        `${skillsDir}:/readonly/skills:ro`,
      ],
      RestartPolicy: { Name: 'no' },
    },
    Labels: {
      'gemix.storageId': storageId,
      'gemix.project': projectName,
    },
  };

  const container = await docker.createContainer(createOpts);
  await container.start();

  const inspect = await container.inspect();
  const internalIp = inspect.NetworkSettings.Networks[SANDBOX_NETWORK]?.IPAddress;

  // The kernel will be wired in by getOrCreate() once the container is up.
  return {
    storageId,
    projectName,
    container,
    containerId: container.id,
    containerName,
    hostPort,
    internalIp,
    token,
    kernel: null,
    lastUsedAt: Date.now(),
    busy: false,
  };
}

/**
 * Wait for the Jupyter Server inside the container to accept HTTP. Polls
 * GET /api/status for up to ~60 s.
 */
function _waitForKernelHttp(entry, timeoutMs = 60_000) {
  const { hostPort, internalIp, token } = entry;
  return new Promise((resolve, reject) => {
    const http = require('http');
    const start = Date.now();
    let tryInternal = false;

    const tick = () => {
      // Try host loopback first, fallback to internal IP if host fails
      const currentHost = tryInternal && internalIp ? internalIp : '127.0.0.1';
      const currentPort = tryInternal && internalIp ? 8888 : hostPort;

      const req = http.get({
        host: currentHost,
        port: currentPort,
        path: `/api/status?token=${token}`,
        timeout: 5000,
        headers: {
          'Authorization': `token ${token}`
        }
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          return resolve();
        }
        return retry();
      });

      req.on('error', (err) => {
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
          log.warn(`Sandbox probe error on ${currentHost}:${currentPort}: ${err.message} (${err.code})`);
        }
        // Switch between host and internal IP on every retry if both are available
        if (internalIp) tryInternal = !tryInternal;
        retry();
      });
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Jupyter Server boot timeout (waited ${timeoutMs}ms on host port ${hostPort} / internal ${internalIp}:8888)`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

/**
 * Public: get (or create) the running sandbox + ready kernel for the given
 * user / project. Concurrent calls for the same key share the same boot
 * promise.
 */
async function getOrCreate(userCtx, projectName) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) throw new Error('Cannot resolve storageId');
  const key = _poolKey(storageId, projectName);

  let entry = _pool.get(key);
  if (entry && entry._bootPromise) {
    await entry._bootPromise;
    entry.lastUsedAt = Date.now();
    return entry;
  }
  if (entry && entry.kernel && entry.kernel.isAlive()) {
    entry.lastUsedAt = Date.now();
    return entry;
  }
  let wasRestarted = false;
  // Stale / dead — purge before recreate
  if (entry) {
    log.warn(`pool entry for ${key} is dead, recreating`);
    await _killEntry(entry).catch(err => log.warn(`failed to purge stale sandbox ${key}: ${err.message}`));
    _pool.delete(key);
    wasRestarted = true;
  }

  const bootPromise = (async () => {
    const fresh = await _spawnContainer(userCtx, projectName);
    try {
      await _waitForKernelHttp(fresh);
      fresh.kernel = new PythonKernel({
        host: fresh.internalIp || '127.0.0.1',
        port: fresh.internalIp ? 8888 : fresh.hostPort,
        token: fresh.token,
      });
      await fresh.kernel.start();
    } catch (err) {
      // If boot failed, try to capture container logs for debugging before killing it
      try {
        const logsBuf = await fresh.container.logs({ stdout: true, stderr: true, tail: 100 });
        // Docker multiplexes stdout/stderr into a binary format if TTY is off.
        // Each chunk has an 8-byte header: [type, 0, 0, 0, size1, size2, size3, size4]
        let logLines = '';
        let offset = 0;
        while (offset + 8 <= logsBuf.length) {
          const type = logsBuf.readUInt8(offset);
          const size = logsBuf.readUInt32BE(offset + 4);
          const chunk = logsBuf.slice(offset + 8, offset + 8 + size);
          logLines += chunk.toString('utf8');
          offset += 8 + size;
        }
        if (!logLines && logsBuf.length > 0) logLines = logsBuf.toString('utf8'); // fallback
        log.error(`Sandbox boot failed for ${projectName}. Container logs:\n${logLines.trim() || '(empty logs)'}`);
      } catch (logErr) {
        log.warn(`Failed to capture logs for failed sandbox ${projectName}: ${logErr.message}`);
      }
      await _killEntry(fresh).catch(killErr => log.warn(`cleanup after failed sandbox boot (${projectName}) failed: ${killErr.message}`));
      throw err;
    }
    return fresh;
  })();

  const placeholder = { _bootPromise: bootPromise };
  _pool.set(key, placeholder);

  try {
    const ready = await bootPromise;
    ready.lastUsedAt = Date.now();
    if (wasRestarted) ready.wasRestarted = true;
    _pool.set(key, ready);
    log.info(`sandbox ready key=${key} container=${ready.containerName}`);
    return ready;
  } catch (err) {
    _pool.delete(key);
    throw err;
  }
}

/**
 * Mark an entry as used (call this after every successful execution to push
 * back the idle reaper).
 */
function touch(entry) {
  if (entry) entry.lastUsedAt = Date.now();
}

/**
 * Check if a specific sandbox is pooled and its kernel is alive.
 */
function isSandboxAlive(userCtx, projectName) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) return false;
  const key = _poolKey(storageId, projectName);
  const entry = _pool.get(key);
  if (!entry || entry._bootPromise) return false;
  return !!(entry.kernel && entry.kernel.isAlive());
}

/**
 * Forcibly remove a single sandbox.
 */
async function _killEntry(entry) {
  try { if (entry.kernel) await entry.kernel.shutdown(); } catch (err) { log.warn(`kernel shutdown failed for ${entry.containerName || entry.containerId || 'unknown'}: ${err.message}`); }
  if (entry.container) {
    try { await entry.container.stop({ t: 2 }); } catch (err) { log.warn(`container stop failed for ${entry.containerName || entry.containerId || 'unknown'}: ${err.message}`); }
    try { await entry.container.remove({ force: true }); } catch (err) { log.warn(`container remove failed for ${entry.containerName || entry.containerId || 'unknown'}: ${err.message}`); }
  }
}

async function shutdown(userCtx, projectName) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) return;
  const key = _poolKey(storageId, projectName);
  const entry = _pool.get(key);
  if (!entry) return;
  _pool.delete(key);
  await _killEntry(entry);
  log.info(`sandbox shut down key=${key}`);
}

async function shutdownAll() {
  const entries = [..._pool.values()];
  _pool.clear();
  await Promise.all(entries.map(e => _killEntry(e).catch(err => log.warn(`shutdownAll cleanup failed: ${err.message}`))));
}

/**
 * Cleanup any orphan containers left over from previous runs.
 * Matches containers by the "gemix-sb-" name prefix or GemiX labels.
 * Called automatically on startup.
 */
async function cleanupOrphanSandboxes() {
  let docker;
  try {
    docker = _getDocker();
  } catch (err) {
    // If dockerode is not installed or docker is not reachable, skip cleanup
    log.debug(`Orphan cleanup skipped: ${err.message}`);
    return;
  }

  try {
    const containers = await docker.listContainers({ all: true });
    // Docker prefixes names with a forward slash
    const orphans = containers.filter(c => 
      c.Names.some(name => name.startsWith('/gemix-sb-')) || 
      (c.Labels && (c.Labels['gemix.storageId'] || c.Labels['gemix.project']))
    );
    
    if (orphans.length === 0) return;

    log.info(`Found ${orphans.length} orphan sandbox containers. Cleaning up...`);
    for (const cInfo of orphans) {
      try {
        const container = docker.getContainer(cInfo.Id);
        if (cInfo.State === 'running') {
          // Attempt a quick stop, then force remove
          await container.stop({ t: 2 }).catch(() => {});
        }
        await container.remove({ force: true });
        log.info(`Cleaned up orphan container ${cInfo.Names[0]} (${cInfo.Id.slice(0, 12)})`);
      } catch (err) {
        // HTTP 409 means container removal is already in progress - normal temporary state
        if (err.message && err.message.includes('409') && err.message.includes('already in progress')) {
          log.debug(`Orphan container ${cInfo.Id.slice(0, 12)} removal already in progress, skipping`);
        } else {
          log.warn(`Failed to cleanup orphan container ${cInfo.Id.slice(0, 12)}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.error(`Error during orphan sandbox cleanup: ${err.message}`);
  }
}

// ── Idle reaper ─────────────────────────────────────────────────────────────

const _reaper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _pool.entries()) {
    if (!entry.lastUsedAt) continue; // skip booting entries
    if (entry.busy) continue;
    if (now - entry.lastUsedAt > SANDBOX_IDLE_TTL_MS) {
      log.info(`reaping idle sandbox ${key} (idle ${(now - entry.lastUsedAt) / 1000 | 0}s)`);
      _pool.delete(key);
      _killEntry(entry).catch(err => log.warn(`reap kill failed: ${err.message}`));
    }
  }
}, 60_000);
_reaper.unref();

// Start cleanup in the background as soon as the module is loaded (on startup).
cleanupOrphanSandboxes().catch(err => log.error(`Background orphan cleanup failed: ${err.message}`));

// Best-effort cleanup when the bot terminates.
let _shutdownHookInstalled = false;
function installShutdownHook() {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;
  const handler = async (signal) => {
    log.info(`shutting down all sandboxes (${signal})…`);
    try { await shutdownAll(); } catch (err) { log.warn(`shutdown hook cleanup failed (${signal}): ${err.message}`); }
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
  process.once('beforeExit', () => handler('beforeExit'));
}

module.exports = {
  getOrCreate,
  touch,
  shutdown,
  shutdownAll,
  installShutdownHook,
  isSandboxAlive,
  cleanupOrphanSandboxes, // Exposed for manual trigger if needed
  // Exposed for tests / diagnostics
  _pool,
  _poolKey,
};
