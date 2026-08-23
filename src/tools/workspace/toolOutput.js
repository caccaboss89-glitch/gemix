// src/tools/workspace/toolOutput.js
//
// Where a file a tool produced ends up, and what the model is told about it.
//
// Everything a tool generates — an image, a song, a PDF — lands in the same
// `workspace/` the model reads and writes itself, and the tool answers with the
// path. There is no separate buffer of pending files: the path the tool returns
// is the path `read_file`, `send_email` and the reply's `attachments[]` take
// (spec §18.16), so nothing has to be named back before it can be used.

import path from 'path';
import { stageAttachmentBuffer, stageAttachmentFromPath } from '../../sandbox/workspaceFs.js';
import { ROOT, hostRoot, toDisplayPath } from '../../sandbox/workspacePaths.js';

/**
 * Put a produced file in the workspace and describe it in namespace terms.
 *
 * @param {string} workspaceId
 * @param {string} desiredName - sanitized and de-duplicated by the staging layer
 * @param {Buffer|{ srcPath: string }} source
 * @returns {{ display: string, name: string, abs: string, sizeBytes: number }}
 * @throws when the workspace cannot be resolved, or the quota would be exceeded
 *   (`err.code === 'EQUOTA'`)
 */
function stageToolOutput(workspaceId, desiredName, source) {
  if (!workspaceId) throw new Error('Cannot resolve the workspace for this conversation.');
  const staged = Buffer.isBuffer(source)
    ? stageAttachmentBuffer(workspaceId, desiredName, source)
    : stageAttachmentFromPath(workspaceId, desiredName, source.srcPath);
  const root = hostRoot(workspaceId, ROOT.WORKSPACE);
  return {
    display: toDisplayPath(ROOT.WORKSPACE, staged.finalName),
    name: staged.finalName,
    abs: path.join(root, staged.finalName),
    sizeBytes: staged.sizeBytes
  };
}

export { stageToolOutput };
