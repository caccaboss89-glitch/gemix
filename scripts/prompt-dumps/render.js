// scripts/prompt-dumps/render.js
//
// Turns one case (or the workspace runtime) into the exact text written to
// scripts/output-regenerate-prompt-dumps/. Rendering only — every assertion
// about the result lives in validate.js.

import {
  buildStaticInstructions,
  buildDynamicRuntimeContext
} from '../../src/ai/systemPrompt.js';
import { getToolsForUser } from '../../src/ai/tools.js';
import { buildGemixResponseFormat } from '../../src/ai/responseSchema.js';
import constants from '../../src/config/constants.js';
import {
  getCapabilities
} from '../../src/config/platformCapabilities.js';
import envConfig from '../../src/config/env.js';
import { _resetActiveProfileForTests } from '../../src/ai/providers/providerProfile.js';
import { defaultSettings } from '../../src/utils/settingsStore.js';

const {
  PLATFORM_DISCORD,
  PLATFORM_WA_DEDICATED,
  SHELL_TIMEOUT_DEFAULT_MS,
  SHELL_TIMEOUT_MAX_MS,
  WORKSPACE_QUOTA_LABEL,
  WORKSPACE_TTL_LABEL
} = constants;

import workspaceRuntime from '../../src/sandbox/workspaceRuntime.js';
import { ATOMIC_WRITE_SCRIPT } from '../../src/tools/workspace/mutation.js';
import { CASES, MOCK_ACTIVE_MEMBERS } from './cases.js';

/** Tool names the workspace-runtime dump quotes verbatim. */
const WORKSPACE_TOOL_NAMES = new Set(['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']);

// -- Schema rendering ------------------------------------------------------

function renderProp(name, schema, isRequired, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  const type = Array.isArray(schema.type) ? schema.type.join('|') : (schema.type || 'any');
  const req = isRequired ? ', required' : '';
  const enumStr = Array.isArray(schema.enum) ? ` enum=[${schema.enum.join('|')}]` : '';
  const constraints = [];
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (Number.isFinite(schema[key])) constraints.push(`${key}=${schema[key]}`);
  }
  if (typeof schema.pattern === 'string') constraints.push(`pattern=${JSON.stringify(schema.pattern)}`);
  if (schema.type === 'object' && schema.additionalProperties === false) constraints.push('additionalProperties=false');
  const constraintStr = constraints.length > 0 ? ` ${constraints.join(' ')}` : '';
  const desc = schema.description ? ` — ${schema.description}` : '';
  lines.push(`${pad}${name} (${type}${req}${enumStr})${constraintStr}${desc}`);
  if (schema.type === 'object' && schema.properties) {
    const childReq = new Set(schema.required || []);
    for (const [k, v] of Object.entries(schema.properties)) {
      lines.push(...renderProp(k, v, childReq.has(k), indent + 2));
    }
  }
  if (schema.type === 'array' && schema.items) {
    if (schema.items.type === 'object' && schema.items.properties) {
      const itemConstraints = [];
      if (schema.items.additionalProperties === false) itemConstraints.push('additionalProperties=false');
      const itemRequired = Array.isArray(schema.items.required) ? schema.items.required : [];
      if (itemRequired.length > 0) itemConstraints.push(`required=[${itemRequired.join('|')}]`);
      const itemConstraintStr = itemConstraints.length > 0 ? ` ${itemConstraints.join(' ')}` : '';
      lines.push(`${pad}  items (object)${itemConstraintStr}:`);
      const childReq = new Set(schema.items.required || []);
      for (const [k, v] of Object.entries(schema.items.properties)) {
        lines.push(...renderProp(k, v, childReq.has(k), indent + 4));
      }
    } else if (schema.items.type) {
      lines.push(`${pad}  items: ${schema.items.type}`);
    }
  }
  return lines;
}

function renderTools(tools) {
  // Preserve getToolsForUser order (importance), not “all functions then natives”.
  let fnCount = 0;
  let nativeCount = 0;
  for (const t of tools) {
    if (t?.type === 'function' && t.function) fnCount += 1;
    else if (t?.type && t.type !== 'function') nativeCount += 1;
  }
  const out = [`--- TOOLS (${fnCount} function + ${nativeCount} native, registry order) ---`];
  for (const t of tools) {
    if (t?.type === 'function' && t.function) {
      const fn = t.function;
      out.push(`[function] ${fn.name}`);
      out.push(`    desc: ${fn.description}`);
      const props = fn.parameters && fn.parameters.properties ? fn.parameters.properties : {};
      const required = new Set((fn.parameters && fn.parameters.required) || []);
      const keys = Object.keys(props);
      if (keys.length === 0) {
        out.push(`    params: object additionalProperties=${fn.parameters?.additionalProperties !== false}`);
      } else {
        const requiredList = [...required];
        out.push(
          `    params: object additionalProperties=${fn.parameters?.additionalProperties !== false}`
          + ` required=[${requiredList.join('|')}]`
        );
        for (const k of keys) out.push(...renderProp(k, props[k], required.has(k), 6));
      }
      continue;
    }
    if (t?.type && t.type !== 'function') {
      out.push(`[native] ${JSON.stringify(t)}`);
    }
  }
  return out.join('\n');
}

function renderResponseFormat(fmt) {
  const out = ['--- STRUCTURED OUTPUT (text.format) ---'];
  if (!fmt) {
    out.push('(none — plain-text reply this round)');
    return out.join('\n');
  }
  out.push(`json_schema "${fmt.name}" (strict=${Boolean(fmt.strict)})`);
  const props = (fmt.schema && fmt.schema.properties) || {};
  const required = new Set((fmt.schema && fmt.schema.required) || []);
  out.push(
    `schema: object additionalProperties=${fmt.schema?.additionalProperties !== false}`
    + ` required=[${[...required].join('|')}]`
  );
  for (const [k, v] of Object.entries(props)) {
    out.push(...renderProp(k, v, required.has(k), 4));
  }
  return out.join('\n');
}

// -- Case dumps ------------------------------------------------------------

/**
 * Shape of input[] as handler.js builds it. Identical for every case, but the
 * placement of <user_query> and of the frozen Runtime block is the point of the
 * whole arrangement, so each dump carries it.
 */
function renderInputLayout() {
  return [
    '--- INPUT LAYOUT (handler.js) ---',
    '[0]      role:system   static instructions below (the only role:system item)',
    '[1..n]   history       rebuilt from the platform each turn, untagged',
    '[n+1]    role:user     <user_query>…</user_query> — the whole debounced burst as ONE item',
    '[n+2]    role:user     <Runtime>…</Runtime> — built once per turn, never moved',
    '[n+3..]  reasoning / function_call / function_call_output / <system-reminder>, appended per round'
  ].join('\n');
}

/**
 * @param {number} id - key into CASES
 * @returns {{ staticPart: string, dynamicPart: string, dump: string }}
 */
/**
 * Run `fn` under the provider profile a case asks for, then put the process back
 * as it was. The profile is resolved per call, so swapping it here is enough for
 * the prompt, the tool registry and the response schema to follow. Validation
 * has to run inside the same window as the render, which is why this wraps a
 * callback instead of living inside renderCase.
 */
function underCaseDeployment(id, fn) {
  const deployment = CASES[id]?.deployment || { provider: 'chatgpt', cloudflare: true };
  const saved = {
    provider: envConfig.AI_PROVIDER,
    accounts: envConfig.CLOUDFLARE_AI_ACCOUNTS
  };
  envConfig.AI_PROVIDER = deployment.provider;
  // Placeholder pair: the dump only asks whether a backend is configured, and
  // never calls it.
  envConfig.CLOUDFLARE_AI_ACCOUNTS = deployment.cloudflare
    ? (saved.accounts.length > 0 ? saved.accounts : [{ accountId: 'dump-account', apiToken: 'dump-token' }])
    : [];
  _resetActiveProfileForTests();
  try { return fn(); }
  finally {
    Object.assign(envConfig, {
      AI_PROVIDER: saved.provider,
      CLOUDFLARE_AI_ACCOUNTS: saved.accounts
    });
    _resetActiveProfileForTests();
  }
}

function renderCase(id) {
  const spec = CASES[id];
  const ctx = { ...spec.ctx };

  // Resolve defaults inside the case's provider window. Explicit cases carry
  // only their overrides so a ChatGPT dump gets max while an xAI dump gets high.
  const suppliedSettings = ctx.settings;
  const preferenceOptions = { allowVoice: Boolean(getCapabilities(ctx).voiceReply) };
  ctx.settings = {
    ...defaultSettings(preferenceOptions),
    ...(suppliedSettings || {}),
    updatedAt: suppliedSettings?.updatedAt || null,
    reviewedAt: suppliedSettings?.reviewedAt || null
  };

  const staticPart = buildStaticInstructions(ctx, undefined, { activeMembers: MOCK_ACTIVE_MEMBERS });
  const dynamicPart = buildDynamicRuntimeContext(ctx);

  const identity = ctx.userIdentity || {};
  const userCtx = {
    platform: ctx.platform,
    isGroup: ctx.isGroup,
    chatId: ctx.chatId
  };
  const tools = getToolsForUser({
    ...userCtx,
    isActiveMember: Boolean(identity.isActiveMember),
    isAdmin: Boolean(identity.isAdmin),
    isLegal: Boolean(identity.isLegal)
  });
  const isDiscord = ctx.platform === PLATFORM_DISCORD;
  const responseFormat = buildGemixResponseFormat({
    includeTitle: isDiscord,
    allowVoice: Boolean(getCapabilities(ctx).voiceReply)
  });

  const dump = [
    `=== CASE ${id} ${spec.label} ===`,
    `(delivery: discordTitleField=${isDiscord})`,
    '',
    renderInputLayout(),
    '',
    '--- STATIC INSTRUCTIONS (input[0], role:system) ---',
    staticPart,
    '',
    '--- DYNAMIC RUNTIME (per-turn role:user item after the user message; not system) ---',
    dynamicPart,
    '',
    '',
    renderTools(tools),
    '',
    renderResponseFormat(responseFormat)
  ].join('\n');

  return { staticPart, dynamicPart, dump };
}

// -- Workspace runtime dump ------------------------------------------------

function renderWorkspaceRuntimeDump() {
  const shellSpec = workspaceRuntime.buildExecSpec({
    command: 'ffmpeg -i input.mov -c:v libx264 out.mp4',
    timeoutMs: SHELL_TIMEOUT_DEFAULT_MS
  });
  const writeSpec = workspaceRuntime.buildExecSpec({
    command: ['/bin/bash', '-c', ATOMIC_WRITE_SCRIPT, 'workspace_text_write', '/workspace/report.md']
  });
  // One context for the whole dump: the mounts a container gets and the roots
  // the schemas name come from the same capability, so they cannot disagree.
  const runtimeCtx = {
    isActiveMember: true,
    isAdmin: true,
    platform: PLATFORM_WA_DEDICATED,
    isGroup: false
  };
  const tools = getToolsForUser(runtimeCtx);
  const workspaceTools = tools.filter(t => WORKSPACE_TOOL_NAMES.has(t?.function?.name));
  const mounts = [
    '/workspace    rw   the agent working area',
    '/attachments  ro   projection of the conversation files'
  ];
  if (getCapabilities(runtimeCtx).skills) {
    mounts.push('/skills       ro   the shared skill library, one per deployment');
  }

  return [
    '=== WORKSPACE RUNTIME (container exec contract + filesystem tools) ===',
    '',
    '--- MOUNTS ---',
    ...mounts,
    '',
    '--- EXEC ENV (every exec; no credential is ever passed) ---',
    JSON.stringify(workspaceRuntime.containerEnv(), null, 2),
    '',
    '--- EXEC: shell ---',
    `cmd: ${JSON.stringify(shellSpec.cmd)}`,
    `timeoutMs: ${shellSpec.timeoutMs} (max ${SHELL_TIMEOUT_MAX_MS})`,
    '',
    '--- EXEC: write_file / edit_file (content arrives on stdin) ---',
    `cmd: ${JSON.stringify(writeSpec.cmd)}`,
    '',
    '--- HOST CONTRACT ---',
    '- Reads (read_file / list_files / search_files) run in-process on the host.',
    '- Mutations (write_file / edit_file / shell) run via docker exec and take the per-workspace lock.',
    `- Quota ${WORKSPACE_QUOTA_LABEL}, checked after every mutation; TTL ${WORKSPACE_TTL_LABEL} of inactivity.`,
    '- Package installs (pip/npm/apt) are disabled in the image.',
    '',
    '--- TOOL SCHEMAS ---',
    workspaceTools.map(t => `${t.function.name}: ${t.function.description}`).join('\n\n')
  ].join('\n');
}

export { renderCase, renderWorkspaceRuntimeDump, underCaseDeployment };
