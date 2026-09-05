// Tool-generated files reserve aggregate quota under one workspace lock.
// Multi-file results are built outside the model's workspace and published
// together by directory rename, so an interrupted batch is never half-visible.

import { assertRootCapacity } from '../../sandbox/workspaceFs.js';
import {
  clearPendingWorkspaceOutputs,
  stageUniqueWorkspaceBuffer,
  stageWorkspaceBufferBatch
} from '../../sandbox/hostFileGateway.js';
import { ROOT, toDisplayPath } from '../../sandbox/workspacePaths.js';
import { withWorkspaceLock } from '../../utils/workspaceState.js';

function _validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('At least one tool output is required.');
  }
  return outputs.map((output, index) => {
    if (!output || !Buffer.isBuffer(output.source)) {
      throw new Error(`Tool output ${index + 1} must be provided as bytes.`);
    }
    return { desiredName: output.desiredName, source: output.source };
  });
}

async function stageToolOutputsBatch(workspaceId, rawOutputs) {
  if (!workspaceId) throw new Error('Cannot resolve the workspace for this conversation.');
  const outputs = _validateOutputs(rawOutputs);
  return withWorkspaceLock(workspaceId, {}, async () => {
    clearPendingWorkspaceOutputs(workspaceId);
    const incomingBytes = outputs.reduce((total, output) => total + output.source.length, 0);
    const extraDirectory = outputs.length > 1 ? 1 : 0;
    assertRootCapacity(workspaceId, incomingBytes, 0, ROOT.WORKSPACE, outputs.length + extraDirectory);
    const staged = outputs.length === 1
      ? [stageUniqueWorkspaceBuffer(workspaceId, outputs[0].desiredName, outputs[0].source)]
      : stageWorkspaceBufferBatch(workspaceId, outputs);
    return staged.map(file => ({
      display: toDisplayPath(ROOT.WORKSPACE, file.finalName),
      name: file.finalName,
      sizeBytes: file.sizeBytes
    }));
  });
}

async function stageToolOutput(workspaceId, desiredName, source) {
  const [staged] = await stageToolOutputsBatch(workspaceId, [{ desiredName, source }]);
  return staged;
}

export { stageToolOutput, stageToolOutputsBatch };
