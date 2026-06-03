// src/tools/build.js
//
// `build` tool: hand a task to the engineering sub-agent (GemiX-Build).
//
// Responsibilities (host side):
//   1. Resolve the workspaceId (group:<id> or user:<storageId>).
//   2. Acquire the per-workspace build lock with a 30s wait.
//   3. Resolve every filename in `attachments[]` to a real file:
//        - first the current-turn buffer (responseCtx.attachments),
//        - then chat history (history/<filename>).
//   4. Stage each resolved attachment into /workspace/, renaming on
//      collision and recording the rename so the agent learns the new name.
//   5. For attachments that do not live on disk yet (current-turn
//      buffers without filePath), expose them via the public tunnel so the
//      sub-agent ingests them as input_file URLs on round 1. This keeps a
//      consistent mental model: files are in /workspace/ AND visible
//      directly to the model on the first turn.
//   6. Invoke runBuildAgent, await the {message, delivered} result.
//   7. Push delivered files into responseCtx.attachments so the main
//      brain's reply carries them to the user automatically.
//   8. Release the lock and return a structured tool result to the main brain.
//
// The tool call is rate-limited to once per main-brain round (set in
// ONCE_PER_ROUND_TOOLS in tools/index.js) so the agent finishes before the
// main brain considers another delegation.

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
  resolveInsideWorkspace,
} = require('../sandbox/buildWorkspace');
const { acquireBuildLock, releaseBuildLock } = require('../utils/buildState');
const { runBuildAgent } = require('../ai/buildAgent');
const { getUserHistoryPaths } = require('../utils/historySync');
const { resolveStorageId } = require('../utils/userPaths');

const { classifyAiFileDelivery, DELIVERY_MODE, exposeTunnelFromAbsPath } = require('../utils/aiFileDelivery');
const { sanitizeFilename } = require('../utils/text');
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
 * Try to find an attachment by filename:
 *   1. In the current-turn buffer (responseCtx.attachments[]) by `name` match.
 *   2. In chat history for this user.
 *
 * Returns { source: 'buffer'|'history', filePath?, buffer?, name } on hit,
 * null on miss.
 */
function _resolveAttachment(filename, userCtx, responseCtx) {
  if (typeof filename !== 'string' || !filename.trim()) return null;
  const target = path.basename(filename.trim());

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

/**
 * Stage a single attachment into the workspace and (when needed) prepare
 * an `input_file` URL part to inject in round 1 of the agent.
 *
 * For files copied from disk, the agent's <WorkspaceState> + its own read_file
 * is used to access them; no URL is sent on round 1.
 * For buffers materialized fresh, the input_file URL is also attached on
 * round 1 to give the model immediate visibility.
 */
function _stageOne(attachment, workspaceId) {
  if (attachment.filePath) {
    return stageAttachmentFromPath(workspaceId, attachment.name, attachment.filePath);
  }
  if (attachment.buffer) {
    return stageAttachmentBuffer(workspaceId, attachment.name, attachment.buffer);
  }
  throw new Error('attachment has neither filePath nor buffer');
}

/**
 * Build an input_file URL part for a freshly-staged in-workspace file.
 * Used on round 1 only when the source is a buffer (i.e. content the model
 * has never seen before; for history files the agent reads them on demand).
 *
 * Security note: exposes a short-lived HTTPS URL on the attachment tunnel (accepted risk).
 */
async function _makeRound1FilePart(workspaceId, finalName, mimetypeHint) {
  const abs = resolveInsideWorkspace(workspaceId, finalName);
  if (!abs || !fs.existsSync(abs)) return null;
  const tunnel = await exposeTunnelFromAbsPath(abs, finalName, {
    kind: 'temp',
    contentType: mimetypeHint,
  });
  if (!tunnel.success) {
    log.warn(`Round-1 tunnel skipped for ${finalName}: ${tunnel.error}`);
    return null;
  }
  return { name: finalName, url: tunnel.url };
}

/**
 * Push delivered files (named by the agent in <DELIVER>) into
 * responseCtx.attachments so the main brain's reply ships them to the user.
 *
 * Skips silently:
 *   - filenames that escape /workspace/,
 *   - files that don't exist (the agent referenced something it never wrote),
 *   - duplicates present in the buffer.
 *
 * Returns the list of attached names and the list of skipped names,
 * so the tool result is transparent about what reached the user.
 */
function _attachDelivered(workspaceId, delivered, responseCtx) {
  const attached = [];
  const missing = [];
  if (!Array.isArray(delivered) || delivered.length === 0) return { attached, missing };
  if (!responseCtx || !Array.isArray(responseCtx.attachments)) return { attached, missing };

  // Guard against the agent listing the same workspace file twice in one
  // <DELIVER> - each distinct workspace file is delivered at most once.
  const seenSources = new Set();

  for (const raw of delivered) {
    const cleaned = sanitizeFilename(path.basename(String(raw || '').trim()));
    if (!cleaned) continue;
    if (seenSources.has(cleaned)) continue;
    seenSources.add(cleaned);
    const abs = resolveInsideWorkspace(workspaceId, cleaned);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push(cleaned);
      continue;
    }
    const ext = path.extname(cleaned).toLowerCase();
    const mimetype = mimeForExtension(ext);
    // Dedup against the buffer (rename to name(1).ext on clash) so a generated
    // asset present in the buffer never shadows a build deliverable. The model
    // learns the final name via the returned `attached` list (build reports it
    // as `delivered`).
    const finalName = pushBufferAttachment(responseCtx, {
      name: cleaned,
      filePath: abs,
      mimetype,
    });
    attached.push(finalName);
  }
  return { attached, missing };
}

/**
 * Tool implementation.
 *
 * @param {object} args
 * @param {string} args.prompt - English brief describing the task.
 * @param {string[]} [args.attachments] - filenames available in chat history
 *   or in the current-turn delivery buffer.
 * @param {object} userCtx
 * @param {object} responseCtx
 * @returns {Promise<object>}
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

  // -- Resolve attachments BEFORE acquiring the lock so a missing-file
  // error fails fast without blocking the workspace.
  const resolved = [];
  const notFound = [];
  for (const name of requestedAttachments) {
    const r = _resolveAttachment(name, userCtx, responseCtx);
    if (r) resolved.push({ requested: name, ...r });
    else notFound.push(name);
  }
  if (notFound.length > 0 && resolved.length === 0) {
    return {
      success: false,
      error: `Cannot find requested attachment(s): ${notFound.join(', ')}. Tell the user which file is missing or retry without those attachments.`,
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
    // -- Stage attachments into /workspace/ ---------------------------------
    const renamedAttachments = [];
    const attachmentParts = []; // round-1 input_file URLs for buffer-only sources
    const stagingErrors = [];
    for (const r of resolved) {
      try {
        const staged = _stageOne(r, workspaceId);
        if (staged.renamed) {
          renamedAttachments.push({ requested: r.requested, actual: staged.finalName });
        }
        // Buffer sources: model has never seen this content; surface it
        // immediately on round 1 so the agent doesn't have to call read_file.
        if (r.source === 'buffer' && !r.filePath) {
          const ext = path.extname(staged.finalName).toLowerCase();
          const mimeHint = mimeForExtension(ext);
          if (classifyAiFileDelivery(staged.finalName, mimeHint) === DELIVERY_MODE.TUNNEL) {
            const part = await _makeRound1FilePart(workspaceId, staged.finalName, mimeHint);
            if (part) attachmentParts.push(part);
          }
        }
      } catch (err) {
        stagingErrors.push(`${r.requested}: ${err.message}`);
      }
    }

    if (stagingErrors.length > 0) {
      return {
        success: false,
        error: `Failed to stage attachments: ${stagingErrors.join('; ')}`,
      };
    }

    // -- Run the sub-agent -------------------------------------------------
    const agentResult = await runBuildAgent({
      workspaceId,
      prompt,
      renamedAttachments,
      attachmentParts,
      lockOwnerId,
    });

    if (!agentResult.success) {
      return {
        success: false,
        error: agentResult.error || 'build agent failed without a clear error.',
        rounds_used: agentResult.roundsUsed,
        research_stats: agentResult.research_stats || null,
      };
    }

    // -- Deliver files to the main brain's response buffer -----------------
    const { attached, missing } = _attachDelivered(workspaceId, agentResult.delivered || [], responseCtx);

    // Bubble the agent's research stats up to the main brain so the badge
    // (web/X sources) remains accurate when the agent does its own searches.
    if (agentResult.research_stats) {
      if (!responseCtx.researchStats) responseCtx.researchStats = { webSources: 0, xPosts: 0 };
      responseCtx.researchStats.webSources += agentResult.research_stats.webSources || 0;
      responseCtx.researchStats.xPosts += agentResult.research_stats.xPosts || 0;
    }

    return {
      success: true,
      message: agentResult.message || '',
      delivered: attached,
      delivered_missing: missing,
      attachments_not_found: notFound,
      attachments_renamed: renamedAttachments.map(r => `${r.requested} -> ${r.actual}`),
      rounds_used: agentResult.roundsUsed,
    };
  } finally {
    releaseBuildLock(workspaceId, lockOwnerId);
  }
}

module.exports = { buildTool };
