// src/tools/workspace/toolOutput.js
//
// Where a file a tool produced ends up, and what the model is told about it.
//
// Everything a tool generates — an image, a song, a PDF — lands in the same
// `workspace/` the model reads and writes itself, and the tool answers with the
// path. There is no separate buffer of pending files: the path the tool returns
// is the path `read_file`, `send_email` and the reply's `attachments[]` take
// so nothing has to be named back before it can be used.

import { assertRootCapacity } from '../../sandbox/workspaceFs.js';
import { stageUniqueWorkspaceBuffer } from '../../sandbox/hostFileGateway.js';
import { ROOT, toDisplayPath } from '../../sandbox/workspacePaths.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

/**
 * Put a produced file in the workspace and describe it in namespace terms.
 *
 * @param {string} workspaceId
 * @param {string} desiredName - sanitized and de-duplicated by the staging layer
 * @param {Buffer} source
 * @returns {Promise<{ display: string, name: string, sizeBytes: number }>}
 * @throws when the workspace cannot be resolved, or the quota would be exceeded
 *   (`err.code === 'EQUOTA'`)
 */
async function stageToolOutput(workspaceId, desiredName, source) {
  if (!workspaceId) throw new Error('Cannot resolve the workspace for this conversation.');
  if (!Buffer.isBuffer(source)) throw new Error('Tool output must be provided as bytes.');
  return withWorkspaceLock(workspaceId, {}, async () => {
    assertRootCapacity(workspaceId, source.length);
    const staged = stageUniqueWorkspaceBuffer(workspaceId, desiredName, source);
    return {
      display: toDisplayPath(ROOT.WORKSPACE, staged.finalName),
      name: staged.finalName,
      sizeBytes: staged.sizeBytes
    };
  });
}

export { stageToolOutput };
