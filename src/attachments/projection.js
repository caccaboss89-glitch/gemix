// src/attachments/projection.js
//
// The read-only `/attachments` view of a conversation's files.
//
// History is the durable store (data/users/<storageId>/history/). This module
// materializes, under the workspace's own `attachments/` directory, exactly the
// files the visible history window still refers to — which is what makes the
// tag invariant hold: every live `[Attachment: attachments/x]` the model reads
// has a real file behind it, reachable with `read_file` and visible in the
// container at `/attachments/x`.
//
// Retention is 4h sliding from last use, not from arrival: projecting a file
// again refreshes its mtime, so a conversation that keeps coming back to the
// same document keeps it. The hourly sweep drops whatever has gone quiet. The
// old post-turn referential prune is gone — it deleted files the next turn
// still wanted, which is exactly the invariant this replaces.
//
// The projection is a copy, not a hard link: a link would share an inode with
// the history file, so refreshing the projection's mtime would silently rewrite
// history's own retention clock.

import fs from 'fs';
import path from 'path';
import constants from '../config/constants.js';
import { getAttachmentsPath, getWorkspaceMetaDir } from '../utils/workspaceId.js';
import { ROOT, toDisplayPath } from '../sandbox/workspacePaths.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Attachments');

/** Sliding retention, shared with the workspace TTL so both sweep together. */
const ATTACHMENT_TTL_MS = constants.WORKSPACE_TTL_MS;

/** Refresh mtime at most this often; a turn touching a file twice writes once. */
const TOUCH_DEBOUNCE_MS = 60 * 1000;

/** The namespace path the model sees for a projected file. */
function attachmentDisplayPath(name) {
  return toDisplayPath(ROOT.ATTACHMENTS, path.basename(String(name || '')));
}

function _projectedPath(workspaceId, name) {
  const root = getAttachmentsPath(workspaceId);
  const base = path.basename(String(name || ''));
  if (!root || !base || base === '.' || base === '..') return null;
  return path.join(root, base);
}

/** True when the file is currently materialized in the projection. */
function isProjected(workspaceId, name) {
  const dest = _projectedPath(workspaceId, name);
  if (!dest) return false;
  try { return fs.statSync(dest).isFile(); }
  catch { return false; }
}

/**
 * Push the retention clock forward on an already-projected file.
 * @returns {boolean} whether the file is there at all
 */
function touchProjected(workspaceId, name) {
  const dest = _projectedPath(workspaceId, name);
  if (!dest) return false;
  let stat;
  try { stat = fs.statSync(dest); }
  catch { return false; }
  if (!stat.isFile()) return false;
  if (Date.now() - stat.mtimeMs < TOUCH_DEBOUNCE_MS) return true;
  try { fs.utimesSync(dest, new Date(), new Date()); }
  catch (err) { log.debug(`touch ${path.basename(dest)}: ${err.message}`); }
  return true;
}

/**
 * Materialize one file into the projection, or refresh it if already there.
 *
 * @param {string} workspaceId
 * @param {string} sourceAbsPath - the durable copy (history, or a fresh ingress)
 * @param {string} [name] - name inside the projection, defaults to the source's
 * @returns {{ display: string, name: string, abs: string }|null} null when the
 *   source is gone, which is the caller's cue to emit an `(expired)` tag
 */
function projectFile(workspaceId, sourceAbsPath, name = null) {
  const finalName = path.basename(name || sourceAbsPath || '');
  const dest = _projectedPath(workspaceId, finalName);
  if (!dest || !sourceAbsPath) return null;

  let sourceStat;
  try { sourceStat = fs.statSync(sourceAbsPath); }
  catch { return null; }
  if (!sourceStat.isFile() || sourceStat.size === 0) return null;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let destStat = null;
    try { destStat = fs.statSync(dest); } catch { /* not projected yet */ }
    // Same size and not older than the source means the copy still matches; a
    // history file is never edited in place, only replaced.
    if (!destStat || destStat.size !== sourceStat.size || destStat.mtimeMs < sourceStat.mtimeMs) {
      fs.copyFileSync(sourceAbsPath, dest);
    } else {
      touchProjected(workspaceId, finalName);
    }
  } catch (err) {
    log.warn(`Cannot project ${finalName}: ${err.message}`);
    return null;
  }

  return { display: attachmentDisplayPath(finalName), name: finalName, abs: dest };
}

/**
 * Write a buffer straight into the projection. Used for files that have no
 * durable history copy yet at the moment the model needs to see the path.
 */
function projectBuffer(workspaceId, name, buffer) {
  const finalName = path.basename(String(name || ''));
  const dest = _projectedPath(workspaceId, finalName);
  if (!dest || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  } catch (err) {
    log.warn(`Cannot project ${finalName}: ${err.message}`);
    return null;
  }
  return { display: attachmentDisplayPath(finalName), name: finalName, abs: dest };
}

/** Remove one projected file (privacy wipe, or a source that turned out bad). */
function unprojectFile(workspaceId, name) {
  const dest = _projectedPath(workspaceId, name);
  if (!dest) return;
  try { fs.unlinkSync(dest); }
  catch { /* already gone */ }
}

/**
 * Drop projected files nothing has touched for the retention window.
 *
 * Runs on the same hourly schedule as the workspace sweep. Sweeping by mtime
 * rather than by a reference list is deliberate: the reference list is exactly
 * what went wrong before, because a file can leave the visible window for one
 * turn and be needed again on the next.
 *
 * @param {number} [now]
 * @returns {{ removed: number, kept: number }}
 */
function sweepExpiredAttachments(now = Date.now()) {
  const usersDir = path.join(constants.DATA_DIR, 'users');
  let removed = 0;
  let kept = 0;
  let slugs;
  try { slugs = fs.readdirSync(usersDir, { withFileTypes: true }); }
  catch { return { removed, kept }; }

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(usersDir, slug.name, 'attachments');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      try {
        if (now - fs.statSync(file).mtimeMs <= ATTACHMENT_TTL_MS) { kept++; continue; }
        fs.unlinkSync(file);
        removed++;
      } catch (err) {
        log.debug(`sweep ${entry.name}: ${err.message}`);
      }
    }
  }
  if (removed > 0) log.info(`Attachment sweep: removed ${removed} expired file(s), kept ${kept}`);
  return { removed, kept };
}

/** Wipe a conversation's whole projection (privacy wipe, workspace expiry). */
function clearProjection(workspaceId) {
  const root = getAttachmentsPath(workspaceId);
  if (!root) return;
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch (err) { log.warn(`Cannot clear the projection: ${err.message}`); }
}

/** Where a conversation's projection lives, for the privacy wipe report. */
function projectionRoot(workspaceId) {
  return getAttachmentsPath(workspaceId) || getWorkspaceMetaDir(workspaceId);
}

export {
  ATTACHMENT_TTL_MS,
  attachmentDisplayPath,
  isProjected,
  touchProjected,
  projectFile,
  projectBuffer,
  unprojectFile,
  sweepExpiredAttachments,
  clearProjection,
  projectionRoot
};
