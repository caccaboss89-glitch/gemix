// src/tools/build.js
//
// `build` tool: hand a task to Grok Build inside the per-workspace Docker sandbox.
//
// Host side:
//   1. Resolve workspaceId; acquire per-workspace lock.
//   2. Resolve attachments[] (buffer / history / URL) and stage into /workspace/.
//   3. Run Grok Build in-container (auth = getXaiAuth token via process env only).
//   4. Harvest new/modified workspace files (full tree on clean success with no delta).
//   5. Return free-text agent reply + delivery_note so GemiX selects final user files.
//
// Rate-limited to once per main-brain round (PER_ROUND_TOOL_LIMITS).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLATFORM_DISCORD } = require('../config/constants');
const { mimeForExtension } = require('../config/mimeExtensions');
const { resolveWorkspaceId } = require('../utils/workspaceId');
const { resolveProfile, toolUnavailableMessage, TOOL } = require('../config/platformCapabilities');
const {
  ensureWorkspace,
  stageAttachmentBuffer,
  stageAttachmentFromPath,
  normalizeWorkspaceRelPath,
  resolveWorkspaceDeliveryFile,
  resolveInsideWorkspace,
} = require('../sandbox/buildWorkspace');
const { acquireBuildLock, releaseBuildLock } = require('../utils/buildState');
const { runBuildAgent, DELIVERY_SELECTION_NOTICE } = require('../ai/buildAgent');
const { getUserHistoryPaths } = require('../utils/historySync');
const { resolveStorageId } = require('../utils/userPaths');
const { resolveUrlEntry } = require('../utils/deliverySelection');
const { applyBuildAgentFlags } = require('../utils/attachmentDelivery');
const { pushBufferAttachment } = require('../utils/attachments');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildTool');

function _historyDirFor(userCtx) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) return null;
  try { return getUserHistoryPaths(storageId).historyDir; }
  catch { return null; }
}

/**
 * Resolve an attachment entry:
 *   1. Public https URLs
 *   2. Delivery buffer by basename
 *   3. Chat history for this user
 */
async function _resolveAttachment(entry, userCtx, responseCtx) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const trimmed = entry.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const resolved = await resolveUrlEntry(trimmed, []);
    if (!resolved.att) {
      log.warn(`build attachment URL download failed (${trimmed.slice(0, 100)}): ${resolved.error?.message || 'unknown'}`);
      return null;
    }
    if (resolved.att.externalUrl) {
      return { source: 'url', name: resolved.att.name, externalUrl: resolved.att.externalUrl };
    }
    return {
      source: 'url',
      name: resolved.att.name,
      buffer: resolved.att.buffer,
      filePath: resolved.att.filePath,
    };
  }

  const target = path.basename(trimmed);

  if (Array.isArray(responseCtx?.attachments)) {
    const buf = responseCtx.attachments.find(a => a && a.name && path.basename(a.name) === target);
    if (buf) {
      if (buf.filePath && fs.existsSync(buf.filePath)) {
        return { source: 'buffer', filePath: buf.filePath, name: buf.name };
      }
      if (Buffer.isBuffer(buf.buffer)) {
        return { source: 'buffer', buffer: buf.buffer, name: buf.name };
      }
    }
  }

  const historyDir = _historyDirFor(userCtx);
  if (historyDir) {
    const candidate = path.join(historyDir, target);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { source: 'history', filePath: candidate, name: target };
    }
  }
  return null;
}

function _stageOne(attachment, workspaceId) {
  if (attachment.filePath) {
    return stageAttachmentFromPath(workspaceId, attachment.name, attachment.filePath);
  }
  if (attachment.buffer) {
    return stageAttachmentBuffer(workspaceId, attachment.name, attachment.buffer);
  }
  throw new Error('attachment has neither filePath nor buffer');
}

/** Best-effort remove staged files after a partial staging failure. */
function _rollbackStaged(workspaceId, stagedNames) {
  for (const name of stagedNames || []) {
    try {
      const abs = resolveInsideWorkspace(workspaceId, name);
      if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        fs.unlinkSync(abs);
      }
    } catch (err) {
      log.warn(`staging rollback ${name}: ${err.message}`);
    }
  }
}

/**
 * Push workspace-relative paths (and optional https URLs) into the delivery buffer.
 */
async function _attachDelivered(workspaceId, delivered, responseCtx) {
  const attached = [];
  const missing = [];
  if (!Array.isArray(delivered) || delivered.length === 0) return { attached, missing };
  if (!responseCtx || !Array.isArray(responseCtx.attachments)) return { attached, missing };

  const seenSources = new Set();

  for (const raw of delivered) {
    const entry = String(raw || '').trim();

    if (/^https?:\/\//i.test(entry)) {
      if (seenSources.has(entry)) continue;
      seenSources.add(entry);
      const resolved = await resolveUrlEntry(entry, responseCtx.attachments, { forBuild: true });
      if (resolved.att) {
        const finalName = pushBufferAttachment(responseCtx, resolved.att);
        attached.push(finalName);
        if (resolved.att.externalUrl) {
          log.warn(`delivered URL too large to host; buffered source link (${entry.slice(0, 100)})`);
        }
      } else {
        log.warn(`delivered URL download failed (${entry.slice(0, 100)}): ${resolved.error?.message || 'unknown'}`);
        missing.push(entry);
      }
      continue;
    }

    const wsRel = normalizeWorkspaceRelPath(entry);
    if (!wsRel) {
      missing.push(entry || '(empty)');
      continue;
    }
    const resolved = resolveWorkspaceDeliveryFile(workspaceId, wsRel);
    if (!resolved) {
      missing.push(wsRel);
      continue;
    }
    const { abs, relPath: cleaned } = resolved;
    if (!cleaned) continue;
    if (seenSources.has(cleaned)) continue;
    seenSources.add(cleaned);
    const ext = path.extname(cleaned).toLowerCase();
    const mimetype = mimeForExtension(ext);
    const displayName = path.basename(cleaned);
    const payload = { name: displayName, filePath: abs, mimetype };
    applyBuildAgentFlags(payload);
    const finalName = pushBufferAttachment(responseCtx, payload);
    attached.push(finalName);
  }
  return { attached, missing };
}

/**
 * @param {object} args
 * @param {string} args.prompt
 * @param {string[]} [args.attachments]
 * @param {object} userCtx
 * @param {object} responseCtx
 */
async function buildTool(args, userCtx, responseCtx) {
  if (userCtx.platform === PLATFORM_DISCORD) {
    return {
      success: false,
      error: toolUnavailableMessage(TOOL.BUILD, resolveProfile(userCtx)),
    };
  }
  const prompt = args && typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) {
    return { success: false, error: 'Missing required argument "prompt".' };
  }
  const requestedAttachments = Array.isArray(args.attachments)
    ? args.attachments.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
    : [];

  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) {
    return { success: false, error: 'Cannot resolve workspace id for this context.' };
  }
  const workspaceDir = ensureWorkspace(workspaceId);
  if (!workspaceDir) {
    return { success: false, error: 'Cannot ensure workspace directory.' };
  }

  const resolved = [];
  const notFound = [];
  for (const name of requestedAttachments) {
    const r = await _resolveAttachment(name, userCtx, responseCtx);
    if (r) resolved.push({ requested: name, ...r });
    else notFound.push(name);
  }
  if (notFound.length > 0 && resolved.length === 0) {
    return {
      success: false,
      error: `Cannot resolve requested attachment(s): ${notFound.join(', ')}. Tell the user which file is missing or retry without those attachments.`,
    };
  }

  let lockOwnerId;
  try {
    lockOwnerId = await acquireBuildLock(workspaceId, {
      ownerId: userCtx.requestId
        ? `${userCtx.requestId}:build`
        : crypto.randomBytes(8).toString('hex'),
    });
  } catch (err) {
    if (err.code === 'EBUILDBUSY') {
      return { success: false, error: err.message };
    }
    throw err;
  }

  try {
    const renamedAttachments = [];
    const stagedNames = [];
    const externalUrls = [];
    const stagingErrors = [];

    for (const r of resolved) {
      try {
        if (r.externalUrl) {
          externalUrls.push(r.externalUrl);
          continue;
        }
        const staged = _stageOne(r, workspaceId);
        stagedNames.push(staged.finalName);
        if (staged.renamed) {
          renamedAttachments.push({ requested: r.requested, actual: staged.finalName });
        }
      } catch (err) {
        stagingErrors.push(`${r.requested}: ${err.message}`);
      }
    }

    if (stagingErrors.length > 0) {
      _rollbackStaged(workspaceId, stagedNames);
      return {
        success: false,
        error: `Failed to stage attachments: ${stagingErrors.join('; ')}`,
      };
    }

    const agentResult = await runBuildAgent({
      workspaceId,
      prompt,
      renamedAttachments,
      stagedNames,
      externalUrls,
      lockOwnerId,
    });

    const harvestList = Array.isArray(agentResult.delivered) ? agentResult.delivered : [];
    const { attached, missing } = await _attachDelivered(workspaceId, harvestList, responseCtx);

    const base = {
      message: agentResult.message || '',
      delivered: attached,
      delivered_missing: missing,
      delivery_note: agentResult.delivery_note || DELIVERY_SELECTION_NOTICE,
      attachments_not_found: notFound,
      attachments_renamed: renamedAttachments.map(r => `${r.requested} -> ${r.actual}`),
      rounds_used: agentResult.roundsUsed,
      timed_out: agentResult.timed_out,
      exit_code: agentResult.exit_code,
    };

    // Success follows Grok process outcome only (not "files already on disk").
    if (!agentResult.success) {
      return {
        success: false,
        error: agentResult.error || 'build agent failed without a clear error.',
        ...base,
      };
    }

    return {
      success: true,
      ...base,
    };
  } finally {
    releaseBuildLock(workspaceId, lockOwnerId);
  }
}

module.exports = { buildTool };
