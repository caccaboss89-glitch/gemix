// src/ai/buildAgent.js
//
// Build sub-agent runner: the active provider's CLI inside the per-workspace
// Docker sandbox (see ai/buildRunners.js for the two back ends).
// Host: immutable --rules, auth via getXaiAuth (token + baseUrl) as process env,
// hard timeout, harvest new/changed workspace files into the delivery path.
// No host-side write_file/edit_file/bash tool loop and no structured attachments JSON.

import constants from '../config/constants.js';
import { renewBuildLock  } from '../utils/buildState.js';
import {
  listWorkspaceFiles,
  ensureWorkspaceWritable,
  normalizeWorkspaceRelPath,
  resolveWorkspaceDeliveryFile
} from '../sandbox/buildWorkspace.js';
import { runnerForProfile  } from './buildRunners.js';
import { profileFromContext  } from './providers/providerProfile.js';
import { createLogger  } from '../utils/logger.js';

const log = createLogger('BuildAgent');

/** Cap free-text captured from the runner's stdout/stderr (bytes). */
const CAPTURE_MAX_BYTES = 200 * 1024;

/** Notice on every build tool result for GemiX-Main. */
const DELIVERY_SELECTION_NOTICE =
  'Workspace files harvested into the delivery buffer for this run are listed in `delivered` '
  + '(new or modified under /workspace/; on a clean success with no delta, all workspace files). '
  + 'Choose which to put in final `attachments` for the user: prefer final deliverables; skip '
  + 'intermediates, sources, logs, and scratch files unless the user asked for them.';

/**
 * Immutable operational rules handed to the build sub-agent.
 *
 * The text is the active runner's: byte-identical to what Grok Build has always
 * received on the xAI profile, and free of any xAI tool, endpoint or capability
 * on the Codex one (see ai/buildRunners.js).
 *
 * @param {object} [opts]
 * @param {Array<{requested:string, actual:string}>} [opts.renamedAttachments]
 * @param {string[]} [opts.stagedNames]
 * @param {string[]} [opts.externalUrls]
 * @param {object} [opts.providerProfile] - the turn's profile
 * @returns {string}
 */
function buildAgentRules({ renamedAttachments, stagedNames, externalUrls, providerProfile } = {}) {
  return runnerForProfile(profileFromContext({ providerProfile }))
    .rules({ renamedAttachments, stagedNames, externalUrls });
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
    delivered: list
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
 * @param {function} [args.getToken] - xAI credential override (tests)
 * @param {function} [args.execAgent] - runner override (tests)
 * @param {object} [args.providerProfile] - the turn's profile
 */
async function runBuildAgent({
  workspaceId,
  prompt,
  renamedAttachments,
  stagedNames,
  externalUrls,
  lockOwnerId,
  getToken,
  execAgent,
  providerProfile
} = {}) {
  const startedAt = Date.now();
  ensureWorkspaceWritable(workspaceId);

  const runner = runnerForProfile(profileFromContext({ providerProfile }));

  let prepared;
  try {
    prepared = await runner.prepare({ getToken });
  } catch (err) {
    return {
      success: false,
      error: err.message.startsWith('Cannot load') ? err.message : runner.credentialError(err.message),
      roundsUsed: 0,
      delivered: [],
      delivery_note: DELIVERY_SELECTION_NOTICE
    };
  }

  const rules = runner.rules({ renamedAttachments, stagedNames, externalUrls });
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

  const runExec = typeof execAgent === 'function'
    ? execAgent
    : runner.exec.bind(runner);
  let execResult;
  try {
    renewBuildLock(workspaceId, lockOwnerId);
    execResult = await runExec(workspaceId, {
      prompt,
      rules,
      timeoutMs: constants.BUILD_HARD_TIMEOUT_MS,
      ...prepared.execOpts
    });
  } catch (err) {
    log.error(`${runner.label} exec failed: ${err.message}`);
    const partial = collectWorkspaceDeltaPaths(workspaceId, beforeSnapshot);
    return {
      success: false,
      error: `${runner.label} failed to start or run: ${err.message}`,
      roundsUsed: 0,
      delivered: partial,
      delivery_note: DELIVERY_SELECTION_NOTICE
    };
  } finally {
    clearInterval(renewIv);
    // The ticket dies with the invocation and the throwaway CODEX_HOME goes
    // with it, whatever the run did.
    prepared.cleanup();
  }

  ensureWorkspaceWritable(workspaceId);

  // Success depends only on process outcome — never on "files exist".
  const execOk = !execResult.timedOut && execResult.rc === 0;
  let deliveredPaths = collectWorkspaceDeltaPaths(workspaceId, beforeSnapshot);
  // Successful no-op / resend: agent may not rewrite files — fall back to full harvest.
  if (execOk && deliveredPaths.length === 0) {
    deliveredPaths = collectAllWorkspaceDeliverablePaths(workspaceId);
  }

  const stdout = _clipCapture(runner.readOutput((execResult.stdout || '').trim()));
  const stderr = _clipCapture((execResult.stderr || '').trim());
  let agentMessage = stdout;
  if (!agentMessage) {
    if (execResult.timedOut) {
      agentMessage = `Build stopped: hard timeout reached before ${runner.label} finished.`;
    } else if (!execOk && stderr) {
      agentMessage = `${runner.label} ended without stdout. stderr: ${stderr.slice(0, 2000)}`;
    }
  }

  const payload = buildBuildToolPayload({
    agentMessage,
    delivered: deliveredPaths
  });

  const durationMs = Date.now() - startedAt;

  if (!execOk) {
    log.warn(
      `build failed: rc=${execResult.rc} timedOut=${execResult.timedOut} `
      + `files=${deliveredPaths.length} durationMs=${durationMs} stderr=${stderr.slice(0, 400)}`
    );
    return {
      success: false,
      error: execResult.timedOut
        ? `Build hard timeout (${constants.BUILD_HARD_TIMEOUT_MS / 1000}s).`
        : (stderr.slice(0, 1500) || `${runner.label} exited with code ${execResult.rc}.`),
      message: payload.message,
      delivered: payload.delivered,
      delivery_note: payload.delivery_note,
      roundsUsed: 1,
      timed_out: Boolean(execResult.timedOut),
      exit_code: execResult.rc,
      duration_ms: durationMs
    };
  }

  log.info(
    `build finished: rc=${execResult.rc} files=${deliveredPaths.length} durationMs=${durationMs}`
  );
  return {
    success: true,
    message: payload.message,
    delivered: payload.delivered,
    delivery_note: payload.delivery_note,
    roundsUsed: 1,
    timed_out: false,
    exit_code: execResult.rc,
    duration_ms: durationMs
  };
}

export {
  runBuildAgent,
  buildAgentRules,
  DELIVERY_SELECTION_NOTICE

};
