// src/ai/buildAgent.js
//
// Build sub-agent for the `build` tool.
// Runs an isolated conversation with dedicated tools
// (write_file/edit_file/bash/read_file/web_x_search/code_interpreter).
// Host (tools/build.js) manages lock, workspace staging and <DELIVER> parsing.
// See: sandbox/buildWorkspace.js, utils/buildState.js, utils/skills.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HERMES_API_KEY, HERMES_BASE_URL, BUILD_MODEL, XAI_REASONING_REPLAY } = require('../config/env');
const { callResponsesModel } = require('./apiClient');
const {
  chatMessagesToResponsesInput,
  chatToolsToResponsesTools,
  responsesToAssistantMessage,
} = require('./responsesAdapter');
const { renewBuildLock } = require('../utils/buildState');
const {
  listWorkspaceFiles,
  workspaceSizeBytes,
  resolveInsideWorkspace,
  QUOTA_BYTES,
} = require('../sandbox/buildWorkspace');
const buildSandbox = require('../sandbox/buildSandbox');
const { deliverReadFileFromPath } = require('../utils/aiFileDelivery');
const { webXSearch } = require('../tools/webXSearch');
const { getRomeTime } = require('../utils/time');
const { sanitizeFilename } = require('../utils/text');
const { WEB_X_SEARCH_RESEARCH_GUIDANCE } = require('./researchGuidance');
const { loadSkills, formatSkillsForPrompt } = require('../utils/skills');
const { SKILLS_DIR } = require('../utils/userPaths');
const {
  BUILD_MAX_ROUNDS,
  BUILD_MAX_WEB_SEARCH_PER_BUILD,
  BUILD_API_TIMEOUT_MS,
  BUILD_HARD_TIMEOUT_MS,
  BUILD_WORKSPACE_QUOTA_MB,
  MAX_TOOL_ROUNDS,
} = require('../config/constants');
const { createLogger } = require('../utils/logger');
const { isNonReadableExt, buildReadFileBlockedMessage } = require('../config/nonReadableExts');
const { mimeForExtension } = require('../config/mimeExtensions');
const {
  executeBuildToolCallsOrdered,
  oncePerRoundDuplicateIds,
  oncePerRoundErrorPayload,
} = require('../utils/toolCallExecution');

const log = createLogger('BuildAgent');

const RESPONSES_URL = `${HERMES_BASE_URL.replace(/\/+$/, '')}/responses`;

const WRITE_FILE_MAX_BYTES = 5 * 1024 * 1024;
const BASH_DEFAULT_TIMEOUT_MS = 30_000;
const BASH_MAX_TIMEOUT_MS = 120_000;

// -- Tool definitions exposed to the sub-agent -----------------------------
//
// Defines the tools available to the sub-agent, including function tools
// and the native `{type:'code_interpreter'}` for server-side Python sandbox
// (zero round cost).

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
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from /workspace/ or /skills/. Only for text/code, images, audio, video, PDF.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path: /workspace/<rel> or /skills/<rel>.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_x_search',
        description:
          'Web and X research via agent or team. '
          + WEB_X_SEARCH_RESEARCH_GUIDANCE
          + ` At most one call per turn and at most ${BUILD_MAX_WEB_SEARCH_PER_BUILD} calls per build`
          + ' (combine topics: one full_team facts pass, optional one search_images).',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Detailed research brief: the exact question, any URLs to consult, desired output format, and constraints (date range, language, sources to prefer or avoid).',
            },
            full_team: {
              type: 'boolean',
              description: 'Set true for 4x multi-agent team (more deep); omit for fast single-model search (default).',
            },
            search_images: {
              type: 'boolean',
              description: 'true → download images to /workspace/ for ImageRun in DOCX/PDF. Default false. Use true for illustrated reports unless user said text-only.',
            },
          },
          required: ['prompt'],
        },
      },
    },
    // Native xAI server-side Python sandbox (zero round cost).
    { type: 'code_interpreter' },
  ];
}

// -- System prompt ---------------------------------------------------------

function _renderWorkspaceState(workspaceId) {
  const { files, total, more } = listWorkspaceFiles(workspaceId, 200);
  if (total === 0) return '<WorkspaceState empty="true"/>';
  const sizeBytes = workspaceSizeBytes(workspaceId);
  const lines = files.map(f => {
    const ageMin = Math.max(0, Math.floor((Date.now() - f.mtimeMs) / 60000));
    const sizeKb = (f.size / 1024).toFixed(1);
    return `  ${f.relPath}  (${sizeKb} KB, ${ageMin} min ago)`;
  });
  if (more) lines.push(`  ... and more (showing first ${files.length})`);
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  return `<WorkspaceState files="${total}" total_size_mb="${sizeMb}" quota_mb="${BUILD_WORKSPACE_QUOTA_MB}">\n${lines.join('\n')}\n</WorkspaceState>`;
}

function _renderAttachmentNotes(renamedAttachments) {
  if (!Array.isArray(renamedAttachments) || renamedAttachments.length === 0) {
    return '<AttachmentNotes/>';
  }
  const items = renamedAttachments.map(a =>
    `  - "${a.requested}" was already present in the workspace and was renamed to "${a.actual}". Use "${a.actual}" in your operations.`
  );
  return `<AttachmentNotes>\n${items.join('\n')}\n</AttachmentNotes>`;
}

// Build the <Skills> block dynamically from the skill folders mounted at
// /skills/ (each with a SKILL.md whose frontmatter carries name + description).
// This keeps the prompt in sync with whatever skills exist on disk.
function _renderSkills() {
  return formatSkillsForPrompt(loadSkills());
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
    '  GemiX-Build, the sub-agent of GemiX. Reasoning and tool calls in English. Final user-facing text in the user\'s language (Italian by default), without emojis unless the user asked for them.',
    `  Time (Europe/Rome): ${getRomeTime()}.`,
    '</Identity>',
    '<Mission>',
    '  Execute the build/code/document task delegated by GemiX-Main. Produce',
    '  deliverables in /workspace/ and announce them via &lt;DELIVER&gt;.',
    '  If the prompt only asks to send existing workspace files (sources, logs, .tex),',
    '  list &lt;WorkspaceState&gt;, deliver what is still on disk—do not rebuild from memory.',
    '</Mission>',
    '<Workspace>',
    '  Working dir: /workspace/  (writable, no fixed structure)',
    '  Skills: /skills/          (read-only)',
    `  Quota: ${BUILD_WORKSPACE_QUOTA_MB} MB. Files persist across build calls in the same session.`,
    '</Workspace>',
    stateBlock,
    notesBlock,
    '<ToolUsage>',
    '  Emit MULTIPLE tool calls in the same round whenever independent — do not waste rounds on serial reads/searches you could batch.',
    '  The system runs tools intelligently: in parallel when possible, bash always last. You can write and run files in the same round.',
    '</ToolUsage>',
    '<Sandbox>',
    '  Applies to bash / write_file / edit_file / read_file (the Docker sandbox at /workspace/). NOT code_interpreter, which is a separate isolated xAI Python environment with its own libraries and no access to /workspace/.',
    '  Python 3.12 and Node.js 22. General-purpose pre-installed libs: numpy, scipy, sympy, mpmath, pandas, matplotlib, seaborn, plotly, Pillow, cairosvg, rembg, jinja2, PyYAML, requests, unoserver. General CLI: ffmpeg, yt-dlp, gs (ghostscript), pdftotext/pdftoppm/pdfimages/pdfinfo/pdftohtml (poppler-utils), libreoffice (headless), pdflatex/xelatex/lualatex (TeX Live), dvipng, curl, wget. No pip/npm/apt at runtime.',
    '  Outbound: only YouTube, X/Twitter, Instagram, TikTok, Facebook — other hosts are blocked by the system.',
    '  yt-dlp: pre-installed. Those platforms only. Run the download command immediately — never which/find/pip/curl/python checks to locate or test yt-dlp. No --proxy, no extractor-arg probes.',
    '</Sandbox>',
    skillsBlock,
    '<Delivery>',
    '  End your final response with &lt;DELIVER&gt;file1.ext, file2.ext&lt;/DELIVER&gt; listing files in /workspace/ to send to the user.',
    '  Empty &lt;DELIVER&gt;&lt;/DELIVER&gt; means "text response only, no files". The tag is REQUIRED on the final response - files NOT listed will not reach the user.',
    '  Media deliverables (converted/re-encoded images, video, audio): prefer a single .zip in &lt;DELIVER&gt; so the chat platform does not re-encode them.',
    '</Delivery>',
    '<Pitfalls>',
    '  Always paths under /workspace/ or /skills/. read_file refuses binary archives (.zip etc.) - use bash (unzip, etc.) instead.',
    '  Files passed as attachments live in /workspace/ root; if &lt;AttachmentNotes&gt; lists a rename, use the renamed name.',
    '  If user wants prior workspace sources (.tex, scripts, logs): read &lt;WorkspaceState&gt;, deliver existing files via &lt;DELIVER&gt; (zip with bash if many).',
    '  yt-dlp: if a download command fails, retry once with a simpler yt-dlp line — never spend rounds on discovery (which, find, pip list, curl tests).',
    '  IMPORTANT: same yt-dlp/sandbox/CLI infrastructure error twice — stop; no retries or workarounds (system fault). &lt;DELIVER&gt;&lt;/DELIVER&gt; and tell GemiX-Main for bug_report.',
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
  const wsRel = trimmed.startsWith('/workspace/')
    ? trimmed.slice('/workspace/'.length)
    : trimmed.replace(/^\/+/, '');
  const abs = resolveInsideWorkspace(workspaceId, wsRel);
  if (!abs) return { ok: false, reason: 'Path escapes /workspace/.' };
  return { ok: true, abs, zone: 'workspace' };
}

async function _executeReadFile(workspaceId, args, ctx = {}) {
  const c = _classifyAgentPath(workspaceId, args && args.path);
  if (!c.ok) return _toolErr(c.reason);
  if (!fs.existsSync(c.abs)) return _toolErr(`File not found: ${args.path}`);

  let stat;
  try { stat = fs.statSync(c.abs); }
  catch (err) { return _toolErr(`Cannot stat: ${err.message}`); }
  if (stat.isDirectory()) return _toolErr('Path is a directory.');

  const ext = path.extname(c.abs).toLowerCase();
  if (isNonReadableExt(ext)) return _toolErr(buildReadFileBlockedMessage(ext));

  const delivery = await deliverReadFileFromPath({
    absPath: c.abs,
    displayPath: args.path,
    contentType: mimeForExtension(ext),
    imagesReadCount: ctx.imagesReadCount ?? 0,
    blockedMessage: buildReadFileBlockedMessage(ext),
    tunnelStorageKind: 'temp',
  });

  if (delivery.kind === 'error') return _toolErr(delivery.error);
  if (delivery.kind === 'tunnel') {
    if (delivery.bumpImageCount) ctx.imagesReadCount = (ctx.imagesReadCount ?? 0) + 1;
    return [
      { type: 'text', text: JSON.stringify({ success: true, message: `File loaded: ${args.path}` }) },
      ...delivery.parts,
    ];
  }
  return JSON.stringify({ success: true, message: delivery.content });
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

async function _executeWebXSearch(workspaceId, args, statsAccumulator) {
  const a = args || {};
  if (typeof a.prompt !== 'string' || !a.prompt.trim()) return _toolErr('Missing prompt.');
  const fullTeam = a.full_team === true;
  const searchImages = a.search_images === true;

  let result;
  try {
    result = await webXSearch(a.prompt, { fullTeam, searchImages });
  } catch (err) { return _toolErr(`Research failed: ${err.message}`); }

  if (result && result._stats && statsAccumulator) {
    const ws = result._stats.webSources || 0;
    const xp = result._stats.xPosts || 0;
    statsAccumulator.webSources = (statsAccumulator.webSources || 0) + ws;
    statsAccumulator.xPosts = (statsAccumulator.xPosts || 0) + xp;
  }

  // Persist any returned images into the workspace root so the agent can use
  // them in the build (e.g. embed in a PDF). Filenames are echoed back.
  const saved = [];
  if (Array.isArray(result?._images) && result._images.length > 0) {
    for (const img of result._images) {
      if (!img || !Buffer.isBuffer(img.buffer)) continue;
      const baseName = sanitizeFilename(img.name || `img_${crypto.randomBytes(4).toString('hex')}.jpg`);
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      let finalName = baseName;
      let abs = resolveInsideWorkspace(workspaceId, finalName);
      if (!abs) continue;
      let i = 1;
      while (fs.existsSync(abs)) {
        finalName = `${stem}(${i})${ext}`;
        abs = resolveInsideWorkspace(workspaceId, finalName);
        i++;
        if (i > 999) break;
      }
      const sizeBefore = workspaceSizeBytes(workspaceId);
      if (sizeBefore + img.buffer.length > QUOTA_BYTES) {
        saved.push({ name: finalName, error: 'workspace quota exceeded' });
        continue;
      }
      try { fs.writeFileSync(abs, img.buffer); saved.push({ name: finalName, size: img.buffer.length }); }
      catch (err) { saved.push({ name: finalName, error: err.message }); }
    }
  }

  const { _stats: _ignored, _images: _ignored2, images_added: _ig3, images_note: _ig4, image_filenames: _ig5, ...clean } = result || {};
  if (saved.length > 0) {
    clean.saved_images = saved.map(s => s.error ? `${s.name} (failed: ${s.error})` : s.name);
    clean.images_note = 'The saved images are in /workspace/ under the listed filenames. Use those exact paths in your scripts.';
  }
  return JSON.stringify(clean);
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
    case 'web_x_search': {
      if (ctx.webSearchCount >= BUILD_MAX_WEB_SEARCH_PER_BUILD) {
        return _toolErr(
          `web_x_search limit reached for this build (max ${BUILD_MAX_WEB_SEARCH_PER_BUILD}: `
          + 'one full_team facts pass, optional one search_images). Combine remaining questions into edit_file/bash — do not start another research call.',
        );
      }
      ctx.webSearchCount += 1;
      return await _executeWebXSearch(ctx.workspaceId, parsedArgs, ctx.researchStats);
    }
    default:              return _toolErr(`Unknown tool "${name}".`);
  }
}

// -- DELIVER tag parsing ---------------------------------------------------

function _parseDeliverTag(text) {
  if (typeof text !== 'string') return { remaining: text, files: [] };
  const re = /<DELIVER>([\s\S]*?)<\/DELIVER>/i;
  const match = re.exec(text);
  if (!match) return { remaining: text, files: [] };
  const inner = match[1].trim();
  const files = inner
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^\/+|\/+$/g, ''));
  const remaining = text.replace(re, '').trim();
  return { remaining, files };
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
 *   message?: string,             // user-facing text, DELIVER tag stripped
 *   delivered?: string[],         // workspace-relative filenames
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
  const ctx = { workspaceId, researchStats, imagesReadCount: 0, webSearchCount: 0 };

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
      // Server-side cap per HTTP call (code_interpreter). Client bash/write/read
      // rounds are bounded by the outer loop below — not by max_turns.
      max_turns: MAX_TOOL_ROUNDS,
      store: false,
    };
    if (XAI_REASONING_REPLAY) {
      body.include = ['reasoning.encrypted_content'];
    }
    if (instructions) body.instructions = instructions;
    if (adaptedTools) body.tools = adaptedTools;

    let data;
    try {
      data = await callResponsesModel('Grok-Build', RESPONSES_URL, body, HERMES_API_KEY, {
        timeoutMs: BUILD_API_TIMEOUT_MS,
        buildRound: rounds,
      });
    } catch (err) {
      log.error(`build agent API call failed at round ${rounds}: ${err.message}`);
      return { success: false, error: err.message, roundsUsed: rounds };
    }

    const assistant = responsesToAssistantMessage(data);

    if (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0) {
      // Push the assistant turn (with content if any) and then each tool result.
      const assistantToPush = { ...assistant };
      if (assistantToPush.content === null || assistantToPush.content === undefined) delete assistantToPush.content;
      messages.push(assistantToPush);
      const blockedOncePerRound = oncePerRoundDuplicateIds(assistant.tool_calls);
      const resultsById = await executeBuildToolCallsOrdered(
        assistant.tool_calls,
        (tc) => {
          if (blockedOncePerRound.has(tc.id)) {
            const name = tc.function?.name || 'tool';
            log.warn(`   build tool blocked (duplicate in round): ${name}`);
            return oncePerRoundErrorPayload(name);
          }
          return _runToolCall(tc, ctx);
        },
      );

      for (const tc of assistant.tool_calls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultsById.get(tc.id),
        });
      }
      const HEAVY_TOOL_PART_TYPES = new Set(['image_url', 'input_file']);
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
  // obtain a text-only response. This lets the agent summarize completed work
  // and include any <DELIVER> tag.
  if (finalText === null && budgetExhausted) {
    log.warn(`   build round budget (${BUILD_MAX_ROUNDS}) exhausted - forcing a final answer (tool_choice:none)`);
    renewBuildLock(workspaceId, lockOwnerId);
    messages[0].content = _buildSystemPrompt(workspaceId, renamedAttachments);
    messages.push({
      role: 'user',
      content:
        'SYSTEM: You have reached your work budget and can no longer run tools. ' +
        'Write your final response now: explain to the user (in their language) ' +
        'what you accomplished and that you had to stop before fully finishing, summarizing the ' +
        'current state of the work. Then list any usable files you already produced in /workspace/ ' +
        'with a <DELIVER>...</DELIVER> tag (empty if none).',
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
      if (instructions) body.instructions = instructions;
      if (adaptedTools) body.tools = adaptedTools;
      if (XAI_REASONING_REPLAY) {
        body.include = ['reasoning.encrypted_content'];
      }
      const data = await callResponsesModel('Grok-Build', RESPONSES_URL, body, HERMES_API_KEY, {
        timeoutMs: BUILD_API_TIMEOUT_MS,
        buildRound: 'wrap-up',
      });
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

  const { remaining, files } = _parseDeliverTag(finalText);
  log.info(`build agent finished: rounds=${rounds}, deliver=${files.length}`);
  return {
    success: true,
    message: remaining,
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
        parts.push({ type: 'input_file', file_url: att.url });
      }
    }
  }
  return parts.length > 0 ? parts : (prompt || '');
}

module.exports = {
  runBuildAgent,
};
