// src/tools/build.js
//
// `build` tool: hand a task to the build sub-agent (GemiX-Build).
//
// Responsibilities (host side):
//   1. Resolve the workspaceId (group:<id> or user:<storageId>).
//   2. Acquire the per-workspace build lock with a 30s wait.
//   3. Resolve every entry in `attachments[]` to a real file:
//        - public https URLs are downloaded,
//        - then the current-turn delivery buffer (responseCtx.attachments),
//        - then chat history (history/<filename>).
//      Intentionally does NOT read files already on disk in the build workspace
//      (<BuildWorkspace> paths): use a deliver-only build prompt and let the
//      sub-agent list them in its structured answer from /workspace/.
//   4. Stage each resolved attachment into /workspace/, renaming on
//      collision and recording the rename so the agent learns the new name.
//   5. For attachments that do not live on disk yet (current-turn
//      buffers without filePath, downloaded URLs), expose them as public
//      URLs so the sub-agent ingests them natively on round 1. This keeps a
//      consistent mental model: files are in /workspace/ AND visible
//      directly to the model on the first turn.
//   6. Invoke runBuildAgent, await the {message, delivered} result.
//   7. Push delivered files (workspace paths and/or public URLs) into
//      responseCtx.attachments - the delivery buffer the main brain selects
//      from when answering.
//   8. Release the lock and return a structured tool result to the main brain.
//
// The tool call is rate-limited to once per main-brain round (set in
// PER_ROUND_TOOL_LIMITS in toolCallExecution.js) so the agent finishes before the
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
const { downloadPublicFile } = require('../utils/fetch');

const { classifyAiFileDelivery, DELIVERY_MODE, exposeXaiUrlFromAbsPath } = require('../utils/aiFileDelivery');
const { sanitizeFilename } = require('../utils/text');
const { pushBufferAttachment, isWhatsAppAudioVideoAttachment } = require('../utils/attachments');
const { createLogger } = require('../utils/logger');

const log = createLogger('BuildTool');

function _historyDirFor(userCtx) {
  const storageId = resolveStorageId(userCtx);
  if (!storageId) return null;
  try { return getUserHistoryPaths(storageId).historyDir; }
  catch { return null; }
}

/**
 * Try to resolve an attachment entry:
 *   1. Public https URLs are downloaded into memory.
 *   2. The current-turn delivery buffer (responseCtx.attachments[]) by `name` match.
 *   3. Chat history for this user.
 * Does not resolve paths under the build workspace (see file header).
 *
 * Returns { source: 'buffer'|'history'|'url', filePath?, buffer?, name } on hit,
 * null on miss.
 */
async function _resolveAttachment(entry, userCtx, responseCtx) {
  if (typeof entry !== 'string' || !entry.trim()) return null;
  const trimmed = entry.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const dl = await downloadPublicFile(trimmed);
      return { source: 'url', buffer: dl.buffer, name: sanitizeFilename(dl.filename) || 'file' };
    } catch (err) {
      log.warn(`build attachment URL download failed (${trimmed.slice(0, 100)}): ${err.message}`);
      return null;
    }
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
 * Build a native file part for a freshly-staged in-workspace file.
 * Used on round 1 only when the source is a buffer or URL (i.e. content the
 * model has never seen before; for history files the agent reads them on demand).
 */
async function _makeRound1FilePart(workspaceId, finalName, mimetypeHint) {
  const abs = resolveInsideWorkspace(workspaceId, finalName);
  if (!abs || !fs.existsSync(abs)) return null;
  const exposed = await exposeXaiUrlFromAbsPath(abs, finalName, {
    mimetype: mimetypeHint,
  });
  if (!exposed.success) {
    log.warn(`Round-1 ingestion skipped for ${finalName}: ${exposed.error}`);
    return null;
  }
  return {
    name: finalName,
    url: exposed.url,
    isImage: classifyAiFileDelivery(finalName, mimetypeHint) === DELIVERY_MODE.IMAGE,
  };
}

/**
 * Push delivered files (listed by the agent in the `attachments` field of its
 * structured answer) into responseCtx.attachments - the delivery buffer the
 * main brain selects from when answering. Entries are /workspace/ paths or
 * public https URLs (downloaded).
 *
 * Skips silently:
 *   - paths that escape /workspace/,
 *   - files that don't exist (the agent referenced something it never wrote),
 *   - duplicates in the same list.
 *
 * Returns the list of attached names and the list of skipped entries,
 * so the tool result is transparent about what reached the buffer.
 */
async function _attachDelivered(workspaceId, delivered, responseCtx) {
  const attached = [];
  const missing = [];
  if (!Array.isArray(delivered) || delivered.length === 0) return { attached, missing };
  if (!responseCtx || !Array.isArray(responseCtx.attachments)) return { attached, missing };

  // Guard against the agent listing the same file twice in one answer -
  // each distinct source is delivered at most once.
  const seenSources = new Set();

  for (const raw of delivered) {
    const entry = String(raw || '').trim();

    if (/^https?:\/\//i.test(entry)) {
      if (seenSources.has(entry)) continue;
      seenSources.add(entry);
      try {
        const dl = await downloadPublicFile(entry);
        const finalName = pushBufferAttachment(responseCtx, {
          name: sanitizeFilename(dl.filename) || 'file',
          buffer: dl.buffer,
          mimetype: dl.mimetype,
        });
        attached.push(finalName);
      } catch (err) {
        log.warn(`delivered URL download failed (${entry.slice(0, 100)}): ${err.message}`);
        missing.push(entry);
      }
      continue;
    }

    const relRaw = entry.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!relRaw || relRaw.split('/').some(seg => seg === '..' || seg === '.')) {
      missing.push(entry || '(empty)');
      continue;
    }
    const cleaned = relRaw
      .split('/')
      .map(seg => sanitizeFilename(seg))
      .filter(Boolean)
      .join('/');
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
    const displayName = path.basename(cleaned);
    // Dedup against the buffer (rename to name(1).ext on clash) so a generated
    // asset present in the buffer never shadows a build deliverable. The model
    // learns the final name via the returned `attached` list (build reports it
    // as `delivered`).
    const payload = { name: displayName, filePath: abs, mimetype };
    if (isWhatsAppAudioVideoAttachment(payload)) payload.waTempLinkPreferred = true;
    const finalName = pushBufferAttachment(responseCtx, payload);
    attached.push(finalName);
  }
  return { attached, missing };
}

/**
 * Tool implementation.
 *
 * @param {object} args
 * @param {string} args.prompt - English brief describing the task.
 * @param {string[]} [args.attachments] - filenames in the delivery buffer or chat history (not workspace disk paths).
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
        // Buffer/URL sources: model has never seen this content; surface it
        // immediately on round 1 so the agent doesn't have to call read_file.
        if (!r.filePath) {
          const ext = path.extname(staged.finalName).toLowerCase();
          const mimeHint = mimeForExtension(ext);
          if (classifyAiFileDelivery(staged.finalName, mimeHint) !== DELIVERY_MODE.TAG_ONLY) {
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

    // -- Deliver files to the main brain's delivery buffer -----------------
    const { attached, missing } = await _attachDelivered(workspaceId, agentResult.delivered || [], responseCtx);

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
