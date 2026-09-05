import { getCapabilities } from '../../src/config/platformCapabilities.js';
import { getToolsForUser } from '../../src/ai/tools.js';
import { ISSUES } from './validationIssues.js';
import { validateToolDumpLeaks } from './schemaValidators.js';

function _validateWorkspaceExecEnv(dump) {
  const marker = '--- EXEC ENV';
  const start = dump.indexOf(marker);
  if (start < 0) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace dump missing the exec env section' });
    return;
  }
  const end = dump.indexOf('\n--- EXEC:', start);
  const envText = end >= 0 ? dump.slice(start, end) : dump.slice(start);
  const forbidden = /API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|BEARER|AUTHORIZATION|OAUTH|_SECRET|_TOKEN\b/i;
  if (forbidden.test(envText)) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace exec env carries a credential-looking variable' });
  }
  if (!/HTTPS_PROXY/.test(envText)) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace exec env missing the fail-closed proxy settings' });
  }
}

function _validateWorkspaceToolDescriptions(platform) {
  const tools = getToolsForUser({ isActiveMember: true, isAdmin: true, platform, isGroup: false });
  const byName = new Map(tools.filter(tool => tool?.function).map(tool => [
    tool.function.name,
    tool.function.description || ''
  ]));
  for (const name of ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']) {
    if (!byName.has(name)) ISSUES.push({ caseId: 'workspace', msg: `main tool schema is missing "${name}"` });
  }
  if (byName.has('build')) {
    ISSUES.push({ caseId: 'workspace', msg: 'the build sub-agent tool is still offered to the model' });
  }
  const readFile = byName.get('read_file') || '';
  if (!/bring a supported local file into your context/i.test(readFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'read_file description does not state its context-ingestion role' });
  }
  if (/whatever its format|only way to open|long or complex documents|use shell/i.test(readFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'read_file schema contains workspace-level strategy guidance' });
  }
  const editFile = byName.get('edit_file') || '';
  if (!/exactly once/i.test(editFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'edit_file description does not state the unique-match contract' });
  }
  const shell = byName.get('shell') || '';
  if (!/pip\/npm\/apt|package installs/i.test(shell)) {
    ISSUES.push({ caseId: 'workspace', msg: 'shell description does not state that package installs are disabled' });
  }
}

function _validateWorkspaceMounts(dump, platform) {
  const block = dump.split('--- MOUNTS ---')[1]?.split('\n\n')[0] || '';
  for (const root of ['/workspace', '/attachments']) {
    if (!block.includes(root)) ISSUES.push({ caseId: 'workspace', msg: `MOUNTS does not list ${root}` });
  }
  const hasSkills = Boolean(getCapabilities({ platform, isGroup: false }).skills);
  if (hasSkills !== block.includes('/skills')) {
    ISSUES.push({
      caseId: 'workspace',
      msg: hasSkills
        ? 'MOUNTS omits /skills, which the tool schemas in this dump name'
        : 'MOUNTS lists /skills, which this platform does not mount'
    });
  }
  if (/\/(attachments|skills)\s+rw/.test(block)) {
    ISSUES.push({ caseId: 'workspace', msg: 'MOUNTS shows a read-only root as writable' });
  }
}

function validateWorkspaceRuntimeDump(dump, platform) {
  if (!dump || !dump.includes('=== WORKSPACE RUNTIME')) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace dump missing its header' });
    return;
  }
  _validateWorkspaceMounts(dump, platform);
  _validateWorkspaceExecEnv(dump);
  _validateWorkspaceToolDescriptions(platform);
  validateToolDumpLeaks(dump, 'workspace');
}

export { validateWorkspaceRuntimeDump };
