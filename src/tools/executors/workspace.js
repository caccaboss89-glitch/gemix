// src/tools/executors/workspace.js
//
// Path-centric workspace executor bindings.

import { editFile } from '../workspace/editFile.js';
import { listFiles } from '../workspace/listFiles.js';
import { readFile } from '../workspace/readFile.js';
import { searchFiles } from '../workspace/searchFiles.js';
import { shell } from '../workspace/shell.js';
import { writeFile } from '../workspace/writeFile.js';
import { resolveWorkspaceId } from '../../utils/workspaceId.js';

async function _executeWorkspaceTool(name, { args, userCtx }) {
  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) return { success: false, error: 'Cannot resolve a workspace for this chat.' };

  const lockOpts = {
    lockOwnerId: userCtx.requestId ? `${userCtx.requestId}:workspace` : undefined
  };
  if (name === 'list_files') return listFiles(args, workspaceId);
  if (name === 'search_files') return searchFiles(args, workspaceId);
  if (name === 'read_file') {
    return readFile(args, workspaceId, {
      language: userCtx.settings?.language,
      signal: userCtx.turnBudget?.signal
    });
  }
  if (name === 'write_file') return writeFile(args, workspaceId, lockOpts);
  if (name === 'edit_file') return editFile(args, workspaceId, lockOpts);
  return shell(args, workspaceId, { ...lockOpts, budget: userCtx.turnBudget || null });
}

const WORKSPACE_TOOL_EXECUTORS = Object.freeze(Object.fromEntries(
  ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']
    .map(name => [name, context => _executeWorkspaceTool(name, context)])
));

export { WORKSPACE_TOOL_EXECUTORS };
