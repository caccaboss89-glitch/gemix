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
import { SANDBOX_BUSY_CODE } from '../../sandbox/workspaceRuntime.js';
import { SANDBOX_BUSY_MESSAGE } from '../../config/systemMessages.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('WorkspaceTools');

/**
 * What the model is told when the sandbox has no slot left. It carries the
 * user-facing line verbatim because this is not the model's failure to explain
 * in its own words: the ceiling is a property of the host, identical for every
 * chat, and the wording is a GemiX system message the history recognises.
 */
const SANDBOX_BUSY_TOOL_ERROR =
  'No sandbox slot is free and this chat has no container open, so no workspace could be started. '
  + 'Do not retry and do not try another tool. Reply to the user with exactly this line, '
  + `nothing added and nothing removed: "${SANDBOX_BUSY_MESSAGE}"`;

async function _executeWorkspaceTool(name, { args, userCtx }) {
  const workspaceId = resolveWorkspaceId(userCtx);
  if (!workspaceId) return { success: false, error: 'Cannot resolve a workspace for this chat.' };

  const lockOpts = {
    lockOwnerId: userCtx.requestId ? `${userCtx.requestId}:workspace` : undefined,
    isAdmin: Boolean(userCtx.isAdmin)
  };
  try {
    if (name === 'list_files') return await listFiles(args, workspaceId);
    if (name === 'search_files') return await searchFiles(args, workspaceId);
    if (name === 'read_file') {
      return await readFile(args, workspaceId, {
        language: userCtx.settings?.language,
        signal: userCtx.turnBudget?.signal
      });
    }
    if (name === 'write_file') return await writeFile(args, workspaceId, lockOpts);
    if (name === 'edit_file') return await editFile(args, workspaceId, lockOpts);
    return await shell(args, workspaceId, { ...lockOpts, budget: userCtx.turnBudget || null });
  } catch (err) {
    // Every workspace tool that can open a container funnels through here, so
    // the refusal is turned into a result once, in one place, rather than
    // travelling up as an exception: the tool round owes the provider a result
    // for every call it made.
    if (err?.code !== SANDBOX_BUSY_CODE) throw err;
    log.warn(`   ${name} refused for ${workspaceId}: no sandbox slot free`);
    return { success: false, error: SANDBOX_BUSY_TOOL_ERROR };
  }
}

const WORKSPACE_TOOL_EXECUTORS = Object.freeze(Object.fromEntries(
  ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']
    .map(name => [name, context => _executeWorkspaceTool(name, context)])
));

export { WORKSPACE_TOOL_EXECUTORS };
