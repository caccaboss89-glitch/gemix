// src/ai/buildAgent.js
//
// Build sub-agent for the `build` tool.
// Runs an isolated conversation with dedicated tools
// (write_file/edit_file/bash/read_file + native xAI
// web_search/x_search/code_interpreter). Host (tools/build.js) manages lock,
// workspace staging and delivery of the files announced in the structured
// final answer (fixed JSON schema: message + optional attachments).
// See: sandbox/buildWorkspace.js, utils/buildState.js, utils/skills.js

const fs = require('fs');
const path = require('path');
const { BUILD_MODEL, XAI_REASONING_REPLAY } = require('../config/env');
const { callResponsesModel } = require('./apiClient');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
  extractServerSearchStats,
} = require('./responsesAdapter');
const { BUILD_RESPONSE_FORMAT, applyResponsesTextFormat, parseStructuredReply } = require('./responseSchema');
const { NATIVE_SEARCH_TOOLS, BUILD_TOOL_READ_FILE } = require('./tools');
const { renewBuildLock } = require('../utils/buildState');
const {
  listWorkspaceFiles,
  workspaceSizeBytes,
  resolveInsideWorkspace,
  normalizeWorkspaceRelPath,
  QUOTA_BYTES,
} = require('../sandbox/buildWorkspace');
const buildSandbox = require('../sandbox/buildSandbox');
const { deliverReadFileFromPath } = require('../utils/aiFileDelivery');
const { getRomeTime } = require('../utils/time');

/** Validate the `path` array arg for the build sub-agent read_file tool. */
function normalizeReadFilePaths(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'path must be a non-empty array of strings.' };
  }
  const paths = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'Each path must be a non-empty string.' };
    }
    paths.push(item.trim());
  }
  return { ok: true, paths };
}
const { loadSkills, formatSkillsForPrompt } = require('../utils/skills');
const { SKILLS_DIR } = require('../utils/userPaths');
const {
  BUILD_MAX_ROUNDS,
  BUILD_API_TIMEOUT_MS,
  BUILD_HARD_TIMEOUT_MS,
  BUILD_WORKSPACE_QUOTA_MB,
  MAX_TOOL_ROUNDS,
} = require('../config/constants');
const { createLogger } = require('../utils/logger');
const { isNonReadableExt, buildReadFileBlockedMessage } = require('../config/nonReadableExts');
const { mimeForExtension } = require('../config/mimeExtensions');
const { executeBuildToolCallsOrdered } = require('../utils/toolCallExecution');

const log = createLogger('BuildAgent');

const WRITE_FILE_MAX_BYTES = 5 * 1024 * 1024;
const BASH_DEFAULT_TIMEOUT_MS = 30_000;
const BASH_MAX_TIMEOUT_MS = 120_000;

// -- Tool definitions exposed to the sub-agent -----------------------------
//
// Function tools run host-side; native xAI tools (web_search, x_search,
// code_interpreter) run server-side inside the same request (zero round cost).

function _buildAgentTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file inside /workspace/. Path must be relative to /workspace/ (e.g. "report.pdf" or "out/chart.png"). UTF-8 text or base64 binary.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path under /workspace/.' },
            content: { type: 'string', description: 'File content (max 5 MB after decoding).' },
            encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Content encoding (default utf-8).' },
            mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default overwrite).' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'In-place edit of a UTF-8 text file inside /workspace/. Replaces old_string with new_string. Use replace_all=true for multiple occurrences.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path under /workspace/.' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command in the /workspace/ sandbox. Full shell syntax is supported (pipes, &&, ||, ;, redirection, subshells). Skills in /skills/ are read-only.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_ms: { type: 'integer', description: `Timeout in ms (default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS}).` },
          },
          required: ['command'],
        },
      },
    },
    BUILD_TOOL_READ_FILE,
    // Native xAI server-side tools (web + X search with
    // image/video understanding and web image search, plus the isolated
    // Python sandbox.
    ...NATIVE_SEARCH_TOOLS,
    { type: 'code_interpreter' },
  ];
}

// -- System prompt ---------------------------------------------------------

function _renderWorkspaceState(workspaceId) {
  const { files, total, more } = listWorkspaceFiles(workspaceId, 200);
  const sizeBytes = workspaceSizeBytes(workspaceId);
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  if (total === 0) {
    return `  <WorkspaceState files="0" total_size_mb="${sizeMb}" quota_mb="${BUILD_WORKSPACE_QUOTA_MB}">\n    (empty)\n  </WorkspaceState>`;
  }
  const lines = files.map(f => {
    const ageMin = Math.max(0, Math.floor((Date.now() - f.mtimeMs) / 60000));
    const sizeKb = (f.size / 1024).toFixed(1);
    return `    ${f.relPath}  (${sizeKb} KB, ${ageMin} min ago)`;
  });
  if (more) lines.push(`    ... and more (showing first ${files.length})`);
  return `  <WorkspaceState files="${total}" total_size_mb="${sizeMb}" quota_mb="${BUILD_WORKSPACE_QUOTA_MB}">\n${lines.join('\n')}\n  </WorkspaceState>`;
}

/** Only when host staged an attachment and the filename collided (e.g. report.pdf → report(1).pdf). */
function _renderAttachmentNotes(renamedAttachments) {
  if (!Array.isArray(renamedAttachments) || renamedAttachments.length === 0) {
    return '';
  }
  const items = renamedAttachments.map(a =>
    `    - brief/staging name "${a.requested}" → on disk "${a.actual}" (use "${a.actual}")`
  );
  return `  <AttachmentNotes>\n    Upload filename collision — use the on-disk name below, not the name from the brief.\n${items.join('\n')}\n  </AttachmentNotes>`;
}

// Build the <Skills> block dynamically from the skill folders mounted at
// /skills/ (each with a SKILL.md whose frontmatter carries name + description).
// This keeps the prompt in sync with whatever skills exist on disk.
function _renderSkills() {
  return formatSkillsForPrompt(loadSkills());
}

const FINISH_NUDGE =
  'SYSTEM: WorkspaceState already contains the deliverable. Stop verification, discovery, and metadata commands. Reply now with final JSON (message + attachments copied from WorkspaceState).';

function _bashCommandFromToolCall(tc) {
  if (tc?.function?.name !== 'bash') return '';
  try {
    const args = typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments;
    return args?.command || '';
  } catch {
    return '';
  }
}

function _isProbeBash(cmd) {
  return /\b(which|ffprobe|ls\s+-|ytsearch[2-9]|ytsearch[1-9]\d|--version|write-info-json|embed-chapter|add-metadata)\b/i.test(cmd);
}

function _maybeInjectFinishNudge(messages, workspaceId, rounds) {
  const { total } = listWorkspaceFiles(workspaceId, 1);
  if (total === 0) return;

  let probeCount = 0;
  let downloadCount = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const cmd = _bashCommandFromToolCall(tc);
      if (!cmd) continue;
      if (_isProbeBash(cmd)) probeCount++;
      if (/\byt-dlp\b/i.test(cmd)) downloadCount++;
    }
  }

  const wasteful = rounds >= 2 && probeCount >= 1 && downloadCount >= 1;
  const tooManyRounds = rounds >= 4;
  if (!wasteful && !tooManyRounds) return;
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && last.content === FINISH_NUDGE) return;
  messages.push({ role: 'user', content: FINISH_NUDGE });
}

function _buildSystemPrompt(workspaceId, renamedAttachments) {
  const stateBlock = _renderWorkspaceState(workspaceId);
  const notesBlock = _renderAttachmentNotes(renamedAttachments);
  const skillsBlock = _renderSkills();

  // No outer <SystemPrompt> envelope: this string is delivered in the
  // dedicated system `instructions` field (the dedicated system channel), so a
  // root tag adds nothing. The structured sub-tags sit flush at the top level.
  return [
    '<Identity>',
    '  GemiX-Build sub-agent. Final reply text in the user\'s language (Italian default), no emojis unless asked.',
    `  Time (Europe/Rome): ${getRomeTime()}.`,
    '</Identity>',
    '<Mission>',
    '  Execute the task brief from GemiX-Main inside /workspace/.',
    '  Reply once with structured JSON when done (see &lt;Delivery&gt;).',
    '</Mission>',
    '<Workspace>',
    '  /workspace/ (writable), /skills/ (read-only). Operate only under these paths.',
    `  ${BUILD_WORKSPACE_QUOTA_MB} MB quota; files persist for the session.`,
    '  &lt;WorkspaceState&gt; is the authoritative on-disk file list (refreshed each round). When files="0", the workspace is empty — do not ls/find/bash to probe.',
    stateBlock,
    ...(notesBlock ? [notesBlock] : []),
    '</Workspace>',
    '<ToolUsage>',
    '  Batch independent tool calls in one round. The system runs tools in parallel when possible; bash runs last.',
    '  You can write and run files in the same round.',
    '</ToolUsage>',
    '<Sandbox>',
    '  bash / write_file / edit_file / read_file run here. code_interpreter is separate (no /workspace/).',
    '  Python 3.12, Node 22, ffmpeg, yt-dlp, LibreOffice, TeX, poppler, curl/wget. No pip/npm/apt.',
    '  Downloads via bash: yt-dlp (video/audio), curl -L -o (files/images). Save under /workspace/.',
    '  yt-dlp: run immediately — no extra checks (e.g. yt-dlp version/ls/ffprobe/metadata probes) unless the brief asks for verification or fixes, no --proxy. On content failure, one simpler retry max.',
    '</Sandbox>',
    ...(skillsBlock ? [skillsBlock] : []),
    '<Delivery>',
    '  Final JSON: `message` (required) + optional `attachments` (workspace paths and/or https URLs). Unlisted files are not delivered.',
    '  Attach only what the brief asks for — skip scratch files (sources, logs, .tex, intermediates) unless requested.',
    '  Every `attachments` path must appear in &lt;WorkspaceState&gt; exactly; never invent paths.',
    '  Resend-only brief: attach only paths listed in &lt;WorkspaceState&gt;.',
    '  Many deliverables: zip first.',
    '</Delivery>',
    '<Pitfalls>',
    '  Network/proxy failure (502, CONNECT error, timeout, could not resolve): internet is down — stop, no retries, tell GemiX-Main for bug_report.',
    '  Same infrastructure error twice: stop, no workarounds, bug_report.',
    '</Pitfalls>',
  ].join('\n');
}

// -- Tool execution dispatcher (sub-agent side) ----------------------------

function _toolErr(msg) {
  return JSON.stringify({ success: false, error: msg });
}

function _classifyAgentPath(workspaceId, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return { ok: false, reason: 'Empty path.' };
  if (rawPath.includes('\0')) return { ok: false, reason: 'Invalid path (null byte).' };
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('/skills/')) {
    const rel = trimmed.slice('/skills/'.length);
    if (rel.includes('..') || path.isAbsolute(rel)) return { ok: false, reason: 'Skills path escapes /skills/.' };
    const abs = path.resolve(SKILLS_DIR, rel);
    if (!abs.startsWith(SKILLS_DIR)) return { ok: false, reason: 'Skills path escapes /skills/.' };
    return { ok: true, abs, zone: 'skills' };
  }
  // Default: workspace
  const wsRel = normalizeWorkspaceRelPath(trimmed);
  if (!wsRel) return { ok: false, reason: 'Invalid workspace path.' };
  const abs = resolveInsideWorkspace(workspaceId, wsRel);
  if (!abs) return { ok: false, reason: 'Path escapes /workspace/.' };
  return { ok: true, abs, zone: 'workspace' };
}

async function _readOneAgentFile(workspaceId, filePath, ctx) {
  const c = _classifyAgentPath(workspaceId, filePath);
  if (!c.ok) return { kind: 'error', path: filePath, error: c.reason };
  if (!fs.existsSync(c.abs)) return { kind: 'error', path: filePath, error: `File not found: ${filePath}` };

  let stat;
  try { stat = fs.statSync(c.abs); }
  catch (err) { return { kind: 'error', path: filePath, error: `Cannot stat: ${err.message}` }; }
  if (stat.isDirectory()) return { kind: 'error', path: filePath, error: 'Path is a directory.' };

  const ext = path.extname(c.abs).toLowerCase();
  if (isNonReadableExt(ext)) return { kind: 'error', path: filePath, error: buildReadFileBlockedMessage(ext) };

  const delivery = await deliverReadFileFromPath({
    absPath: c.abs,
    displayPath: filePath,
    contentType: mimeForExtension(ext),
    imagesReadCount: ctx.imagesReadCount ?? 0,
    blockedMessage: buildReadFileBlockedMessage(ext),
    inlineTextCode: true,
  });

  if (delivery.kind === 'error') return { kind: 'error', path: filePath, error: delivery.error };
  if (delivery.kind === 'parts') {
    if (delivery.bumpImageCount) ctx.imagesReadCount = (ctx.imagesReadCount ?? 0) + 1;
    return { kind: 'parts', displayPath: filePath, parts: delivery.parts };
  }
  return {
    kind: 'inline',
    displayPath: filePath,
    content: delivery.content,
    truncated: delivery.truncated,
  };
}

async function _executeReadFile(workspaceId, args, ctx = {}) {
  const norm = normalizeReadFilePaths(args && args.path);
  if (!norm.ok) return _toolErr(norm.error);

  const fileResults = [];
  const mediaParts = [];
  let hasMediaParts = false;

  for (const filePath of norm.paths) {
    const one = await _readOneAgentFile(workspaceId, filePath, ctx);
    if (one.kind === 'error') {
      fileResults.push({ path: one.path, success: false, error: one.error });
      continue;
    }
    if (one.kind === 'parts') {
      hasMediaParts = true;
      fileResults.push({ path: one.displayPath, success: true });
      mediaParts.push(...one.parts);
      continue;
    }
    fileResults.push({
      path: one.displayPath,
      success: true,
      content: one.content,
      ...(one.truncated ? { truncated: true } : {}),
    });
  }

  const payload = {
    success: fileResults.every(f => f.success),
    files: fileResults,
  };

  if (hasMediaParts) {
    return [
      { type: 'text', text: JSON.stringify(payload) },
      ...mediaParts,
    ];
  }
  return JSON.stringify(payload);
}

function _executeWriteFile(workspaceId, args) {
  const a = args || {};
  const encoding = a.encoding === 'base64' ? 'base64' : 'utf-8';
  const mode = a.mode === 'append' ? 'append' : 'overwrite';
  const c = _classifyAgentPath(workspaceId, a.path);
  if (!c.ok || c.zone !== 'workspace') return _toolErr(c.reason || 'Writes are only allowed under /workspace/.');
  let buf;
  try {
    if (typeof a.content !== 'string') return _toolErr('Missing or invalid content.');
    buf = encoding === 'base64' ? Buffer.from(a.content, 'base64') : Buffer.from(a.content, 'utf-8');
  } catch (err) { return _toolErr(`Decode failed: ${err.message}`); }
  if (buf.length > WRITE_FILE_MAX_BYTES) {
    return _toolErr(`Content too large (${buf.length} bytes, max ${WRITE_FILE_MAX_BYTES}).`);
  }
  // Quota check.
  const sizeBefore = workspaceSizeBytes(workspaceId);
  const existingSize = fs.existsSync(c.abs) && mode === 'overwrite' ? (fs.statSync(c.abs).size || 0) : 0;
  const projectedSize = sizeBefore - existingSize + buf.length;
  if (projectedSize > QUOTA_BYTES) {
    return _toolErr(`Workspace quota would be exceeded (${BUILD_WORKSPACE_QUOTA_MB} MB cap). Delete files before continuing.`);
  }
  try { fs.mkdirSync(path.dirname(c.abs), { recursive: true }); }
  catch (err) { return _toolErr(`Cannot create parent dir: ${err.message}`); }
  try {
    if (mode === 'append' && fs.existsSync(c.abs)) {
      fs.appendFileSync(c.abs, buf);
    } else {
      fs.writeFileSync(c.abs, buf);
    }
  } catch (err) { return _toolErr(`Write failed: ${err.message}`); }
  return JSON.stringify({ success: true, path: a.path, size: buf.length, mode });
}

function _executeEditFile(workspaceId, args) {
  const a = args || {};
  const c = _classifyAgentPath(workspaceId, a.path);
  if (!c.ok || c.zone !== 'workspace') return _toolErr(c.reason || 'Edits are only allowed under /workspace/.');
  if (!fs.existsSync(c.abs)) return _toolErr('File does not exist.');
  if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string') {
    return _toolErr('old_string and new_string must be strings.');
  }
  let text;
  try { text = fs.readFileSync(c.abs, 'utf-8'); }
  catch (err) { return _toolErr(`Read failed: ${err.message}`); }
  const occurrences = text.split(a.old_string).length - 1;
  if (occurrences === 0) return _toolErr('old_string not found in file.');
  if (occurrences > 1 && !a.replace_all) {
    return _toolErr(`old_string occurs ${occurrences} times; pass replace_all=true to apply to all.`);
  }
  const updated = a.replace_all
    ? text.split(a.old_string).join(a.new_string)
    : text.replace(a.old_string, a.new_string);
  // Quota check.
  const newBytes = Buffer.byteLength(updated, 'utf-8');
  const sizeBefore = workspaceSizeBytes(workspaceId);
  const existingSize = fs.statSync(c.abs).size || 0;
  if (sizeBefore - existingSize + newBytes > QUOTA_BYTES) {
    return _toolErr(`Workspace quota would be exceeded (${BUILD_WORKSPACE_QUOTA_MB} MB cap).`);
  }
  try { fs.writeFileSync(c.abs, updated, 'utf-8'); }
  catch (err) { return _toolErr(`Write failed: ${err.message}`); }
  return JSON.stringify({ success: true, path: a.path, occurrences, replaced: a.replace_all ? occurrences : 1 });
}

const SHELL_COMMAND_MAX_LEN = 4000;
async function _executeBash(workspaceId, args) {
  const a = args || {};
  const cmd = a.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return _toolErr('Missing command.');
  if (cmd.length > SHELL_COMMAND_MAX_LEN) return _toolErr(`Command too long (max ${SHELL_COMMAND_MAX_LEN} chars).`);
  let timeoutMs = Number(a.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = BASH_DEFAULT_TIMEOUT_MS;
  if (timeoutMs > BASH_MAX_TIMEOUT_MS) timeoutMs = BASH_MAX_TIMEOUT_MS;
  let res;
  try { res = await buildSandbox.execBash(workspaceId, cmd, { timeoutMs }); }
  catch (err) { return _toolErr(`Sandbox failure: ${err.message}`); }
  return JSON.stringify({
    success: res.rc === 0,
    rc: res.rc,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    timed_out: res.timedOut,
    duration_ms: res.durationMs,
  });
}

async function _runToolCall(toolCall, ctx) {
  const name = toolCall.function && toolCall.function.name;
  let parsedArgs = {};
  try { parsedArgs = JSON.parse(toolCall.function.arguments || '{}'); }
  catch { /* leave empty */ }

  log.info(`   build tool: ${name} args=${JSON.stringify(parsedArgs)}`);
  switch (name) {
    case 'write_file':    return _executeWriteFile(ctx.workspaceId, parsedArgs);
    case 'edit_file':     return _executeEditFile(ctx.workspaceId, parsedArgs);
    case 'bash':          return await _executeBash(ctx.workspaceId, parsedArgs);
    case 'read_file':     return await _executeReadFile(ctx.workspaceId, parsedArgs, ctx);
    default:              return _toolErr(`Unknown tool "${name}".`);
  }
}

// -- Main entry: run the build agent ---------------------------------------

/**
 * @param {object} args
 * @param {string} args.workspaceId
 * @param {string} args.prompt - user-facing task brief from the main brain.
 * @param {Array<{requested:string, actual:string}>} [args.renamedAttachments]
 *   - List of rename-on-collision events to communicate to the agent.
 * @param {Array<{name:string, url:string}>} [args.attachmentParts]
 *   - File parts the host wants the agent to ingest immediately on round 1.
 *     Typically created when staging buffer-only attachments - for files
 *     that already live in /workspace/ on disk, the agent finds them in
 *     <WorkspaceState> and can read them itself.
 * @param {string} args.lockOwnerId - owner id for renewing the lock per round.
 * @returns {Promise<{
 *   success: boolean,
 *   message?: string,             // user-facing text from the structured answer
 *   delivered?: string[],         // workspace-relative paths and/or public URLs
 *   roundsUsed: number,
 *   research_stats?: { webSources:number, xPosts:number },
 *   error?: string,
 * }>}
 */
async function runBuildAgent({ workspaceId, prompt, renamedAttachments, attachmentParts, lockOwnerId }) {
  const startedAt = Date.now();
  const tools = _buildAgentTools();
  const messages = [
    { role: 'system', content: _buildSystemPrompt(workspaceId, renamedAttachments) },
    {
      role: 'user',
      content: _buildUserContent(prompt, attachmentParts),
    },
  ];

  const researchStats = { webSources: 0, xPosts: 0 };
  const ctx = { workspaceId, imagesReadCount: 0 };

  const accumulateSearchStats = (data) => {
    const stats = extractServerSearchStats(data);
    researchStats.webSources += stats.webSources;
    researchStats.xPosts += stats.xPosts;
  };

  let rounds = 0;
  let finalText = null;
  let budgetExhausted = false;

  while (rounds < BUILD_MAX_ROUNDS) {
    rounds++;
    if (Date.now() - startedAt > BUILD_HARD_TIMEOUT_MS) {
      log.warn(`build agent: hard timeout reached at round ${rounds}`);
      budgetExhausted = true;
      break;
    }

    // Refresh the system prompt with the latest workspace state at every
    // round (the agent just wrote new files, the state must reflect them).
    // The agent is never told which round it is on or how many remain - the
    // budget is enforced host-side. When the budget is exhausted, one clean
    // tool-less answer is forced below.
    messages[0].content = _buildSystemPrompt(workspaceId, renamedAttachments);

    // Renew the lock so a long agent run keeps the workspace held.
    renewBuildLock(workspaceId, lockOwnerId);

    const { instructions, input } = chatMessagesToResponsesInput(messages);
    const adaptedTools = chatToolsToResponsesTools(tools);
    const body = {
      model: BUILD_MODEL,
      input,
      max_output_tokens: 64_000,
      tool_choice: 'auto',
      // Server-side cap per HTTP call (web_search/x_search/code_interpreter).
      // Client tool rounds are bounded by the outer loop below — not by max_turns.
      max_turns: MAX_TOOL_ROUNDS,
      store: false,
      // Fixed structured final answer: message + optional attachments.
      // No reasoning.effort here: BUILD_MODEL (e.g. grok-build-0.1) rejects
      // that parameter ("does not support parameter reasoningEffort").
    };
    applyResponsesTextFormat(body, BUILD_RESPONSE_FORMAT);
    if (XAI_REASONING_REPLAY) {
      body.include = ['reasoning.encrypted_content'];
    }
    if (instructions) body.instructions = instructions;
    if (adaptedTools) body.tools = adaptedTools;

    let data;
    try {
      data = await callResponsesModel('Grok-Build', body, {
        timeoutMs: BUILD_API_TIMEOUT_MS,
        buildRound: rounds,
      });
    } catch (err) {
      log.error(`build agent API call failed at round ${rounds}: ${err.message}`);
      return { success: false, error: err.message, roundsUsed: rounds };
    }

    accumulateSearchStats(data);
    const assistant = responsesToAssistantMessage(data);

    if (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0) {
      // Push the assistant turn (with content if any) and then each tool result.
      const assistantToPush = { ...assistant };
      if (assistantToPush.content === null || assistantToPush.content === undefined) delete assistantToPush.content;
      messages.push(assistantToPush);
      const resultsById = await executeBuildToolCallsOrdered(
        assistant.tool_calls,
        (tc) => _runToolCall(tc, ctx),
      );

      for (const tc of assistant.tool_calls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultsById.get(tc.id),
        });
      }
      const HEAVY_TOOL_PART_TYPES = new Set(['image_url', 'input_file', 'input_image']);
      for (const msg of messages) {
        if (msg.role === 'tool' && Array.isArray(msg.content)) {
          if (msg._heavyMediaPreviewSeen) {
            msg.content = msg.content.filter(p => !HEAVY_TOOL_PART_TYPES.has(p.type));
            if (msg.content.length === 1 && msg.content[0].type === 'text') {
              msg.content = msg.content[0].text;
            }
            delete msg._heavyMediaPreviewSeen;
          } else if (msg.content.some(p => HEAVY_TOOL_PART_TYPES.has(p.type))) {
            msg._heavyMediaPreviewSeen = true;
          }
        }
      }
      _maybeInjectFinishNudge(messages, workspaceId, rounds);
      if (rounds >= BUILD_MAX_ROUNDS) budgetExhausted = true;
      continue;
    }

    // No tool calls - final assistant message.
    finalText = assistant.content || '';
    break;
  }

  // -- Round budget / hard-timeout exhausted -------------------------------
  // When no final text has been produced by the time the round budget or hard
  // timeout is reached, a final request is issued with tool_choice:'none' to
  // obtain a structured final answer. This lets the agent summarize completed
  // work and list any usable files.
  if (finalText === null && budgetExhausted) {
    log.warn(`   build round budget (${BUILD_MAX_ROUNDS}) exhausted - forcing a final answer (tool_choice:none)`);
    renewBuildLock(workspaceId, lockOwnerId);
    messages[0].content = _buildSystemPrompt(workspaceId, renamedAttachments);
    messages.push({
      role: 'user',
      content:
        'SYSTEM: You have reached your work budget and can no longer run tools. ' +
        'Write your final answer now: in `message`, explain to the user (in their language) ' +
        'what you accomplished and that you had to stop before fully finishing, summarizing the ' +
        'current state of the work. List any usable files you already produced in /workspace/ ' +
        'in the `attachments` field (omit it if none).',
    });
    try {
      const { instructions, input } = chatMessagesToResponsesInput(messages);
      const adaptedTools = chatToolsToResponsesTools(tools);
      const body = {
        model: BUILD_MODEL,
        input,
        max_output_tokens: 64_000,
        tool_choice: 'none',
        store: false,
      };
      applyResponsesTextFormat(body, BUILD_RESPONSE_FORMAT);
      if (instructions) body.instructions = instructions;
      if (adaptedTools) body.tools = adaptedTools;
      if (XAI_REASONING_REPLAY) {
        body.include = ['reasoning.encrypted_content'];
      }
      const data = await callResponsesModel('Grok-Build', body, {
        timeoutMs: BUILD_API_TIMEOUT_MS,
        buildRound: 'wrap-up',
      });
      accumulateSearchStats(data);
      finalText = responsesToAssistantMessage(data).content || '';
    } catch (err) {
      log.error(`   build forced wrap-up call failed: ${err.message}`);
    }
  }

  if (finalText === null) {
    log.warn(`build agent ended without a final response (rounds=${rounds}/${BUILD_MAX_ROUNDS}).`);
    return {
      success: false,
      error: `build agent reached the round budget (${BUILD_MAX_ROUNDS}) without producing a final response.`,
      roundsUsed: rounds,
      research_stats: researchStats,
    };
  }

  const parsed = parseStructuredReply(finalText);
  if (!parsed.structured) {
    log.warn('build agent final answer was not valid JSON; treating it as plain text.');
  }
  const files = parsed.attachments;
  log.info(`build agent finished: rounds=${rounds}, deliver=${files.length}`);
  return {
    success: true,
    message: parsed.text || '',
    delivered: files,
    roundsUsed: rounds,
    research_stats: researchStats,
  };
}

function _buildUserContent(prompt, attachmentParts) {
  const parts = [];
  if (typeof prompt === 'string' && prompt.trim()) {
    parts.push({ type: 'text', text: prompt });
  }
  if (Array.isArray(attachmentParts) && attachmentParts.length > 0) {
    for (const att of attachmentParts) {
      if (att && typeof att.url === 'string') {
        if (att.name) parts.push({ type: 'text', text: `[Attachment: ${att.name}]` });
        parts.push(att.isImage
          ? { type: 'input_image', image_url: att.url }
          : { type: 'input_file', file_url: att.url });
      }
    }
  }
  return parts.length > 0 ? parts : (prompt || '');
}

module.exports = {
  runBuildAgent,
  // Exported for the offline prompt-dump script (scripts/regenerate-prompt-dumps.js).
  _buildSystemPrompt,
  _buildAgentTools,
};
