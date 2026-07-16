// src/ai/buildAgent.js
//
// Build sub-agent runner: Grok Build CLI inside the per-workspace Docker sandbox.
// Host: immutable --rules, auth via getXaiAuth (token + baseUrl) as process env,
// hard timeout, harvest new/changed workspace files into the delivery path.
// No host-side write_file/edit_file/bash tool loop and no structured attachments JSON.

const { getXaiAuth } = require('../config/xaiAuth');
const {
  BUILD_HARD_TIMEOUT_MS,
  BUILD_MAX_ROUNDS,
  BUILD_WORKSPACE_QUOTA_MB,
} = require('../config/constants');
const { renewBuildLock } = require('../utils/buildState');
const {
  listWorkspaceFiles,
  ensureWorkspaceWritable,
  normalizeWorkspaceRelPath,
  resolveWorkspaceDeliveryFile,
} = require('../sandbox/buildWorkspace');
const buildSandbox = require('../sandbox/buildSandbox');
const { getRomeTime } = require('../utils/time');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildAgent');

/** Cap free-text captured from Grok stdout/stderr (bytes). */
const CAPTURE_MAX_BYTES = 200 * 1024;

/** Notice on every build tool result for GemiX-Main. */
const DELIVERY_SELECTION_NOTICE =
  'Workspace files harvested into the delivery buffer for this run are listed in `delivered` '
  + '(new or modified under /workspace/; on a clean success with no delta, all workspace files). '
  + 'Choose which to put in final `attachments` for the user: prefer final deliverables; skip '
  + 'intermediates, sources, logs, and scratch files unless the user asked for them.';

/**
 * Immutable operational rules for Grok Build (--rules).
 * @param {object} [opts]
 * @param {Array<{requested:string, actual:string}>} [opts.renamedAttachments]
 * @param {string[]} [opts.stagedNames]
 * @param {string[]} [opts.externalUrls]
 * @returns {string}
 */
function buildGrokRules({ renamedAttachments, stagedNames, externalUrls } = {}) {
  const lines = [
    'You are GemiX-Build: complete the task brief inside this isolated container.',
    `Time (Europe/Rome): ${getRomeTime()}.`,
    'Filesystem: work only under /workspace/ (writable). Do not rely on host paths outside it.',
    `Quota: keep the workspace under about ${BUILD_WORKSPACE_QUOTA_MB} MB (host enforces staging caps; do not fill the disk). Files persist for the user session (~4h TTL managed by the host).`,
    'Network: HTTP/HTTPS egress already uses HTTP_PROXY/HTTPS_PROXY (residential), including API calls to xAI. Do not pass --proxy to yt-dlp/curl. On proxy 502, CONNECT errors, timeouts, or DNS failures: internet is down — stop, do not retry loops, explain the system outage in your reply.',
    'Toolchain: Python 3.12, Node 22, ffmpeg, yt-dlp, LibreOffice, TeX, zip/unzip, curl/wget. Runtime pip/npm/apt are disabled — do not attempt package installs.',
    'Use your built-in Grok skills and tools as needed.',
    'IMPORTANT delivery contract: after you finish, the host harvests new/modified files under /workspace/ (and may harvest all files on a successful no-change run, e.g. resend). Write a clear free-text summary of what you did and what files matter; GemiX-Main will select what to send the user.',
    'If GemiX-Main only asks to send/resend files already present: confirm they are under /workspace/ (do not recreate them unless missing) and reply briefly — the host harvests them and forwards to GemiX-Main automatically; you do not list JSON attachments.',
    'Language: write documents in the user\'s language (Italian default). No emojis in your reply or generated files unless the brief asks for them.',
  ];

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
      + externalUrls.join(' | '),
    );
  }
  return lines.join('\n');
}

function _listWorkspaceFileEntries(workspaceId) {
  const { files } = listWorkspaceFiles(workspaceId, 50_000);
  return (files || []).filter((f) => {
    if (!f || typeof f.relPath !== 'string') return false;
    const parts = f.relPath.split('/');
    if (parts.some(p => p === '.grok' || p === '.gemix-grok' || p === 'node_modules')) return false;
    return true;
  });
}

/** Snapshot relPath → { size, mtimeMs } before a Grok run. */
function snapshotWorkspaceFiles(workspaceId) {
  const map = new Map();
  for (const f of _listWorkspaceFileEntries(workspaceId)) {
    map.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs });
  }
  return map;
}

/**
 * Files new or modified vs a pre-run snapshot (verified on disk).
 * @param {string} workspaceId
 * @param {Map<string, {size:number, mtimeMs:number}>} before
 * @returns {string[]}
 */
function collectWorkspaceDeltaPaths(workspaceId, before) {
  const prev = before instanceof Map ? before : new Map();
  const out = [];
  const seen = new Set();
  for (const f of _listWorkspaceFileEntries(workspaceId)) {
    const prior = prev.get(f.relPath);
    const changed = !prior || prior.size !== f.size || f.mtimeMs > prior.mtimeMs;
    if (!changed) continue;
    const rel = normalizeWorkspaceRelPath(f.relPath);
    if (!rel || seen.has(rel)) continue;
    if (!resolveWorkspaceDeliveryFile(workspaceId, rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Every regular harvestable workspace path (verified on disk).
 * @param {string} workspaceId
 * @returns {string[]}
 */
function collectAllWorkspaceDeliverablePaths(workspaceId) {
  const out = [];
  const seen = new Set();
  for (const f of _listWorkspaceFileEntries(workspaceId)) {
    const rel = normalizeWorkspaceRelPath(f.relPath);
    if (!rel || seen.has(rel)) continue;
    if (!resolveWorkspaceDeliveryFile(workspaceId, rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** @deprecated use collectAllWorkspaceDeliverablePaths / collectWorkspaceDeltaPaths */
function collectWorkspaceDeliverablePaths(workspaceId) {
  return collectAllWorkspaceDeliverablePaths(workspaceId);
}

function listAllWorkspaceFilesForHarvest(workspaceId) {
  return _listWorkspaceFileEntries(workspaceId);
}

function _clipCapture(text, maxBytes = CAPTURE_MAX_BYTES) {
  if (typeof text !== 'string' || !text) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.slice(buf.length - maxBytes).toString('utf8');
}

/**
 * @param {object} opts
 * @param {string} opts.agentMessage
 * @param {string[]} opts.delivered
 */
function buildBuildToolPayload({ agentMessage, delivered }) {
  const message = typeof agentMessage === 'string' ? agentMessage : '';
  const list = Array.isArray(delivered) ? delivered.slice() : [];
  return {
    message,
    delivery_note: DELIVERY_SELECTION_NOTICE,
    delivered: list,
  };
}

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {string} args.prompt
 * @param {Array<{requested:string, actual:string}>} [args.renamedAttachments]
 * @param {string[]} [args.stagedNames]
 * @param {string[]} [args.externalUrls]
 * @param {string} args.lockOwnerId
 * @param {function} [args.getToken]
 * @param {function} [args.execGrok]
 */
async function runBuildAgent({
  workspaceId,
  prompt,
  renamedAttachments,
  stagedNames,
  externalUrls,
  lockOwnerId,
  getToken,
  execGrok,
} = {}) {
  const startedAt = Date.now();
  ensureWorkspaceWritable(workspaceId);

  let token;
  let baseUrl;
  try {
    const auth = typeof getToken === 'function' ? getToken() : getXaiAuth();
    token = auth && auth.token;
    baseUrl = auth && auth.baseUrl;
  } catch (err) {
    return {
      success: false,
      error: `Cannot load xAI credentials for build: ${err.message}`,
      roundsUsed: 0,
      delivered: [],
      delivery_note: DELIVERY_SELECTION_NOTICE,
    };
  }
  if (typeof token !== 'string' || !token.trim()) {
    return {
      success: false,
      error: 'Cannot load xAI credentials for build: empty token.',
      roundsUsed: 0,
      delivered: [],
      delivery_note: DELIVERY_SELECTION_NOTICE,
    };
  }

  const rules = buildGrokRules({ renamedAttachments, stagedNames, externalUrls });
  const beforeSnapshot = snapshotWorkspaceFiles(workspaceId);

  const renewIv = setInterval(() => {
    try {
      const ok = renewBuildLock(workspaceId, lockOwnerId);
      if (ok === false) log.warn(`build lock renew returned false workspace=${workspaceId}`);
    } catch (err) {
      log.warn(`build lock renew failed: ${err.message}`);
    }
  }, 30_000);
  renewIv.unref?.();

  const runExec = typeof execGrok === 'function' ? execGrok : buildSandbox.execGrokBuild.bind(buildSandbox);
  let execResult;
  try {
    renewBuildLock(workspaceId, lockOwnerId);
    execResult = await runExec(workspaceId, {
      prompt,
      rules,
      token: token.trim(),
      baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
      timeoutMs: BUILD_HARD_TIMEOUT_MS,
      maxTurns: BUILD_MAX_ROUNDS,
    });
  } catch (err) {
    clearInterval(renewIv);
    log.error(`Grok Build exec failed: ${err.message}`);
    const partial = collectWorkspaceDeltaPaths(workspaceId, beforeSnapshot);
    return {
      success: false,
      error: `Grok Build failed to start or run: ${err.message}`,
      roundsUsed: 0,
      delivered: partial,
      delivery_note: DELIVERY_SELECTION_NOTICE,
    };
  } finally {
    clearInterval(renewIv);
  }

  ensureWorkspaceWritable(workspaceId);

  // Success depends only on process outcome — never on "files exist".
  const execOk = !execResult.timedOut && execResult.rc === 0;
  let deliveredPaths = collectWorkspaceDeltaPaths(workspaceId, beforeSnapshot);
  // Successful no-op / resend: agent may not rewrite files — fall back to full harvest.
  if (execOk && deliveredPaths.length === 0) {
    deliveredPaths = collectAllWorkspaceDeliverablePaths(workspaceId);
  }

  const stdout = _clipCapture((execResult.stdout || '').trim());
  const stderr = _clipCapture((execResult.stderr || '').trim());
  let agentMessage = stdout;
  if (!agentMessage) {
    if (execResult.timedOut) {
      agentMessage = 'Build stopped: hard timeout reached before Grok Build finished.';
    } else if (!execOk && stderr) {
      agentMessage = `Grok Build ended without stdout. stderr: ${stderr.slice(0, 2000)}`;
    }
  }

  const payload = buildBuildToolPayload({
    agentMessage,
    delivered: deliveredPaths,
  });

  const durationMs = Date.now() - startedAt;

  if (!execOk) {
    log.warn(
      `build failed: rc=${execResult.rc} timedOut=${execResult.timedOut} `
      + `files=${deliveredPaths.length} durationMs=${durationMs} stderr=${stderr.slice(0, 400)}`,
    );
    return {
      success: false,
      error: execResult.timedOut
        ? `Build hard timeout (${BUILD_HARD_TIMEOUT_MS / 1000}s).`
        : (stderr.slice(0, 1500) || `Grok Build exited with code ${execResult.rc}.`),
      message: payload.message,
      delivered: payload.delivered,
      delivery_note: payload.delivery_note,
      roundsUsed: 1,
      timed_out: Boolean(execResult.timedOut),
      exit_code: execResult.rc,
      duration_ms: durationMs,
    };
  }

  log.info(
    `build finished: rc=${execResult.rc} files=${deliveredPaths.length} durationMs=${durationMs}`,
  );
  return {
    success: true,
    message: payload.message,
    delivered: payload.delivered,
    delivery_note: payload.delivery_note,
    roundsUsed: 1,
    timed_out: false,
    exit_code: execResult.rc,
    duration_ms: durationMs,
  };
}

module.exports = {
  runBuildAgent,
  buildGrokRules,
  listAllWorkspaceFilesForHarvest,
  collectWorkspaceDeliverablePaths,
  collectAllWorkspaceDeliverablePaths,
  collectWorkspaceDeltaPaths,
  snapshotWorkspaceFiles,
  buildBuildToolPayload,
  DELIVERY_SELECTION_NOTICE,
};
