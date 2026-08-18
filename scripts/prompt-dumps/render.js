// scripts/prompt-dumps/render.js
//
// Turns one case (or the build sub-agent) into the exact text written to
// scripts/output-regenerate-prompt-dumps/. Rendering only — every assertion
// about the result lives in validate.js.

import {
  buildStaticInstructions,
  buildDynamicRuntimeContext
} from '../../src/ai/systemPrompt.js';
import { getToolsForUser } from '../../src/ai/tools.js';
import { buildGemixResponseFormat } from '../../src/ai/responseSchema.js';
import constants from '../../src/config/constants.js';
import { resolveProfile, toolUnavailableMessage, getCapabilities } from '../../src/config/platformCapabilities.js';
import { ADMIN_NOTIFIED_SUFFIX } from '../../src/utils/adminNotifier.js';

const { PLATFORM_DISCORD, BUILD_MAX_ROUNDS, BUILD_HARD_TIMEOUT_MS } = constants;
import {
  PER_ROUND_TOOL_LIMITS,
  perRoundCapErrorPayload
} from '../../src/utils/toolCallExecution.js';
import { formatMediaQuotaResetLabel } from '../../src/utils/mediaUsageLimits.js';
import { defaultSettings, effortsForProvider, visibleSettingFields } from '../../src/utils/settingsStore.js';
import { DELIVERY_SELECTION_NOTICE } from '../../src/ai/buildAgent.js';
import { runnerForProfile } from '../../src/ai/buildRunners.js';
import buildSandbox from '../../src/sandbox/buildSandbox.js';
import { CASES, BASE_SETTINGS } from './cases.js';
import { getProviderProfile, profileFromContext, PROVIDER } from '../../src/ai/providers/providerProfile.js';

// -- Schema rendering ------------------------------------------------------

function renderProp(name, schema, isRequired, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  const type = schema.type || 'any';
  const req = isRequired ? ', required' : '';
  const allowEmptyStr = schema.allowEmpty ? ', empty allowed' : '';
  const enumStr = Array.isArray(schema.enum) ? ` enum=[${schema.enum.join('|')}]` : '';
  const desc = schema.description ? ` — ${schema.description}` : '';
  lines.push(`${pad}${name} (${type}${req}${allowEmptyStr}${enumStr})${desc}`);
  if (schema.type === 'object' && schema.properties) {
    const childReq = new Set(schema.required || []);
    for (const [k, v] of Object.entries(schema.properties)) {
      lines.push(...renderProp(k, v, childReq.has(k), indent + 2));
    }
  }
  if (schema.type === 'array' && schema.items) {
    if (schema.items.type === 'object' && schema.items.properties) {
      lines.push(`${pad}  items (object):`);
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
        out.push('    params: (none)');
      } else {
        out.push('    params:');
        for (const k of keys) out.push(...renderProp(k, props[k], required.has(k), 6));
      }
      continue;
    }
    if (t?.type && t.type !== 'function') {
      out.push(`[native] ${t.type} (server-side, zero round cost)`);
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
  for (const [k, v] of Object.entries(props)) {
    out.push(...renderProp(k, v, required.has(k), 4));
  }
  return out.join('\n');
}

// -- Tool error catalog ----------------------------------------------------

// Deterministic per-tool runtime errors the system can return, mirroring the
// tool implementations (tools/index.js, scheduler.js, imagineGenerator.js,
// openaiImageGenerator.js, build.js, preferences.js). Kept here as an audit
// catalog; update it when a tool's error strings change. Only entries for tools
// live in the case are dumped, and the entries that differ per back end are
// built from the profile so a dump never shows the other one's wording.
function buildToolRuntimeErrors(profile) {
  const runner = runnerForProfile(profile);
  const efforts = effortsForProvider(profile);
  const fields = visibleSettingFields(profile);
  const generateImage = profile.id === PROVIDER.OPENAI
    ? [
      'This image generator takes a prompt only: <fields> are not supported. Describe what you want in the prompt instead.',
      'Missing or too short "prompt": describe the image to generate.',
      'Image generation failed: <reason>',
      'Image generation produced an unusable result: <reason>.',
      'Image could not be stored: <reason>.',
      `Weekly image generation limit reached (5 per week). It resets every ${formatMediaQuotaResetLabel()}.`
    ]
    : [
      'Reference image "<name>" not found in the delivery buffer or chat history.',
      'Too many reference images (<n>). Max allowed: 3.',
      'Each reference image must be a filename or a public https URL.',
      `Weekly image generation limit reached (5 per week). It resets every ${formatMediaQuotaResetLabel()}.`
    ];
  const preferences = [
    'Unable to identify the settings file for this chat.',
    `Nothing to update: pass at least one of ${fields.join(', ')}.`
  ];
  if (fields.includes('voice')) {
    preferences.push('Invalid voice: "<value>". Available voices: <list>.');
  } else {
    preferences.push(`There is no voice setting in this chat: pass one of ${fields.join(', ')}.`);
  }
  preferences.push(
    `Invalid effort: "<value>". Use one of: ${efforts.join(', ')}.`,
    'Invalid language: "<value>". Use one of: <list>.',
    'Memory exceeds the 1000 character limit (<n> chars).'
  );

  return {
    ...STATIC_TOOL_RUNTIME_ERRORS,
    generate_image: generateImage,
    manage_preferences: preferences,
    build: [
      'build is busy: another request is using this workspace.',
      'Missing required argument "prompt".',
      'Cannot resolve workspace id for this context.',
      'Cannot ensure workspace directory.',
      'Cannot resolve requested attachment(s): <names>. Tell the user which file is missing or retry without those attachments.',
      'Failed to stage attachments: <reasons>',
      runner.credentialError('<reason>'),
      `${runner.label} failed to start or run: <reason>`,
      'Build hard timeout (<N>s).',
      'build agent failed without a clear error.',
      'Error executing build: <reason>' + ADMIN_NOTIFIED_SUFFIX
    ]
  };
}

/** The entries that read the same on every back end. */
const STATIC_TOOL_RUNTIME_ERRORS = {
  send_whatsapp_message: [
    'Missing "message" parameter. You must provide the text message to send.',
    'Missing recipient. send_whatsapp_message targets a specific phone number; use your structured reply for the current chat, not this tool.',
    'You cannot send to the current chat with this tool. Use your structured reply instead.',
    'You have already sent a WhatsApp message to this number. Each number can only receive 1 message per request.',
    'Member name is required.',
    'Member "<name>" not found.',
    'Multiple members match "<name>": <names>. Specify a more precise name.',
    'Invalid phone number: use country code and 8–15 digits (e.g. +393331234567).',
    `Error sending WhatsApp message: <reason>${ADMIN_NOTIFIED_SUFFIX}`
  ],
  send_email: [
    'Only active members can send emails.',
    'Invalid email address format: "<email>".',
    '"<member>" has no email on file.',
    'No email address available.',
    'You have already sent an email to this address. Each email can only receive 1 message per request.',
    `Error sending email: <reason>${ADMIN_NOTIFIED_SUFFIX}`
  ],
  schedule_tasks: [
    'Invalid date: "<value>". Use format: YYYY-MM-DDTHH:MM:SS (e.g.: 2026-04-17T16:30:00)',
    'Invalid date: "<value>"',
    'Date <ts> is in the past.',
    'Date <ts> exceeds the 1-year limit.',
    'Recurrence rule is empty. Use e.g. "FREQ=DAILY;INTERVAL=2".',
    'Malformed recurrence segment: "<part>". Use KEY=VALUE separated by ";".',
    'Duplicate recurrence key: "<KEY>".',
    'Unsupported recurrence key: "<KEY>". Allowed: FREQ, INTERVAL, UNTIL, BYDAY, EXDATE.',
    'Recurrence rule needs FREQ. Use one of: HOURLY, DAILY, WEEKLY, MONTHLY.',
    'Invalid FREQ: "<value>". Use one of: HOURLY, DAILY, WEEKLY, MONTHLY.',
    'Invalid INTERVAL: "<value>". Use a whole number >= 1.',
    'BYDAY is only supported with FREQ=WEEKLY.',
    'BYDAY is empty. Use e.g. BYDAY=MO,WE,FR.',
    'Invalid BYDAY value: "<value>". Use SU, MO, TU, WE, TH, FR, SA.',
    'Invalid EXDATE value: "<value>". Use YYYY-MM-DD.',
    'Invalid UNTIL: "<value>". Use YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD.',
    'UNTIL must be after the reminder start date.',
    'UNTIL exceeds the 1-year limit.',
    'Ignored whatsapp.toGroup: you are not in a valid group for this platform.',
    'whatsapp.toGroup requested but no group task file is available.',
    'Specific WhatsApp recipient only available for active members or admin.',
    'toPrivate without a recipient: set whatsapp.recipient to remind a specific person, or whatsapp.toGroup to remind the current group.',
    'Member name is required.',
    'Member "<name>" not found.',
    'Multiple members match "<name>": <names>. Specify a more precise name.',
    'Invalid phone number: use country code and 8–15 digits (e.g. +393331234567).',
    'No valid destination for this task.'
  ],
  read_my_tasks: [
    'includeGroupTasks not available: only in WhatsApp groups.'
  ],
  remove_my_tasks: [
    'fromGroup is only available in WhatsApp group chats. Remove tasks from your personal task file instead.'
  ],
  read_sent_messages: [
    'Unable to identify your account to look up sent messages.',
    'Member name is required.',
    'Member "<name>" not found.',
    'Multiple members match "<name>": <names>. Specify a more precise name.',
    'Invalid phone number: use country code and 8–15 digits (e.g. +393331234567).'
  ],
  generate_video: [
    'Reference image "<name>" not found in the delivery buffer or chat history.',
    'Too many reference images (<n>). Max allowed: 7.',
    `Weekly video generation limit reached (2 per week). It resets every ${formatMediaQuotaResetLabel()}.`
  ],
  generate_music: [
    'Missing prompt parameter in tool call arguments.',
    'A music generation is already in progress...',
    `Weekly song generation limit reached (2 per week). It resets every ${formatMediaQuotaResetLabel()}.`
  ],
  generate_formal_request_pdf: [
    'Error generating formal request PDF: <reason> (admin notified).'
  ],
  bug_report: [
    'Missing required argument "description".'
  ],
  web_image_search: [
    'Missing required argument "query".',
    'Image search is not configured (IMAGE_SEARCH_BASE_URL is invalid).',
    'Image search service rejected JSON format (enable "json" under search.formats in SearXNG settings.yml).',
    'Image search service returned HTTP <status>. Is SearXNG running at <base>?',
    'Image search service returned invalid JSON. Check SearXNG logs and that format=json is enabled.',
    'Image search service unreachable at <base>: <reason>. Ensure the local SearXNG container (gemix-searxng) is running.'
  ]
};

// All tool names that can surface a context/permission error from the system,
// per profile. Used to dump the exact "unavailable" message GemiX gets back.
const ALL_TOOL_NAMES = [
  'web_search', 'x_search', 'web_image_search', 'read_video', 'generate_music', 'generate_image', 'generate_video',
  'build', 'send_whatsapp_message',
  'send_email', 'schedule_tasks', 'read_my_tasks', 'remove_my_tasks',
  'manage_preferences', 'toggle_release_notify',
  'read_music_stats', 'read_sent_messages', 'generate_formal_request_pdf', 'bug_report'
];

/**
 * Render the deterministic tool errors the system returns for this case:
 *   - per-round cap errors (templated)
 *   - schema-validation errors (templated)
 *   - "tool unavailable in this context" messages for every tool NOT in the
 *     live list (the exact text GemiX receives if it tries to call it).
 */
function renderToolErrors(ctx, tools) {
  const profile = resolveProfile(ctx);
  const runtimeErrors = buildToolRuntimeErrors(profileFromContext(ctx));
  const identity = ctx.userIdentity || {};
  const liveNames = new Set(
    tools.map(t => t.function?.name || (t.type !== 'function' ? t.type : null)).filter(Boolean)
  );
  const out = ['--- TOOL ERRORS (system-returned) ---'];

  out.push('[arg validation] Tool arguments must be a JSON object.');
  out.push('[arg validation] Missing required argument "<name>".');
  out.push('[arg validation] Argument "<name>" has wrong type (expected <type>).');
  out.push('[arg validation] Argument "<name>" must be one of: <enum values>.');
  out.push('[arg validation] Argument "<name>" must be a non-empty array.');

  const capped = Object.keys(PER_ROUND_TOOL_LIMITS)
    .filter(n => liveNames.has(n))
    .sort();
  if (capped.length) {
    out.push('[per-round cap]');
    for (const name of capped) {
      const payload = JSON.parse(perRoundCapErrorPayload(name, PER_ROUND_TOOL_LIMITS[name]));
      out.push(`    ${name}: ${payload.error}`);
    }
  }

  // Per-tool runtime errors (only tools live in this case).
  const runtimeNames = Object.keys(runtimeErrors)
    .filter(n => liveNames.has(n))
    .sort();
  if (runtimeNames.length) {
    out.push('[runtime, per tool]');
    for (const name of runtimeNames) {
      out.push(`    ${name}:`);
      for (const msg of runtimeErrors[name]) out.push(`        - ${msg}`);
    }
  }

  const unavailable = ALL_TOOL_NAMES
    .filter(n => !liveNames.has(n))
    .map(n => ({
      name: n,
      msg: toolUnavailableMessage(n, profile, {
        isActiveMember: identity.isActiveMember !== false,
        providerProfile: ctx.providerProfile
      })
    }));
  if (unavailable.length) {
    out.push('[not in this context]');
    for (const u of unavailable) out.push(`    ${u.name}: ${u.msg}`);
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
 * @param {string} providerId - which ProviderProfile this case renders under
 * @returns {{ staticPart: string, dynamicPart: string, dump: string }}
 */
function renderCase(id, providerId) {
  const spec = CASES[id];
  const providerProfile = getProviderProfile(providerId);
  const ctx = { ...spec.ctx, providerProfile };

  // A case declares only the preferences it deliberately changed; everything
  // else is this provider's own default, so a case that edits nothing renders
  // like a fresh chat on either profile.
  ctx.settings = { ...defaultSettings(providerProfile), ...BASE_SETTINGS, ...(spec.ctx.settings || {}) };

  const staticPart = buildStaticInstructions(ctx);
  const dynamicPart = buildDynamicRuntimeContext(ctx);

  const identity = ctx.userIdentity || {};
  const userCtx = {
    platform: ctx.platform,
    isGroup: ctx.isGroup,
    chatId: ctx.chatId,
    providerProfile
  };
  const tools = getToolsForUser(Boolean(identity.isActiveMember), Boolean(identity.isAdmin), userCtx);
  const isDiscord = ctx.platform === PLATFORM_DISCORD;
  const responseFormat = buildGemixResponseFormat({
    includeTitle: isDiscord,
    allowVoice: Boolean(getCapabilities(ctx).voiceReply),
    providerProfile
  });

  const dump = [
    `=== CASE ${id} ${spec.label} [${providerProfile.displayName}] ===`,
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
    renderResponseFormat(responseFormat),
    '',
    renderToolErrors(ctx, tools)
  ].join('\n');

  return { staticPart, dynamicPart, dump };
}

// -- Build sub-agent dump --------------------------------------------------

/**
 * The build sub-agent contract for one provider: the operational rules it is
 * given and the exact argv/env it runs under, with every secret redacted.
 * @param {string} providerId
 * @returns {string}
 */
function renderBuildAgentDump(providerId) {
  const profile = getProviderProfile(providerId);
  const runner = runnerForProfile(profile);
  const rules = runner.rules({
    renamedAttachments: [{ requested: 'logo.png', actual: 'logo(1).png' }],
    stagedNames: ['logo(1).png']
  });

  const isCodex = profile.id === PROVIDER.OPENAI;
  const spec = isCodex
    ? buildSandbox.buildCodexExecSpec({
      prompt: 'Create a short hello.txt in /workspace/',
      rules,
      ticket: 'ticket-placeholder-not-real',
      codexHome: '/tmp/gemix-codex-XXXXXX',
      instructionsFile: '/tmp/gemix-codex-XXXXXX/instructions.md',
      timeoutMs: BUILD_HARD_TIMEOUT_MS
    })
    : buildSandbox.buildGrokExecSpec({
      prompt: 'Create a short hello.txt in /workspace/',
      rules,
      token: 'test-token-not-real',
      maxTurns: BUILD_MAX_ROUNDS,
      timeoutMs: BUILD_HARD_TIMEOUT_MS
    });

  const redactedEnv = (spec.env || []).map((e) => (
    /^(XAI_API_KEY|CODEX_BROKER_TICKET)=/.test(e)
      ? `${e.split('=')[0]}=[REDACTED]`
      : e
  ));

  const hostContract = isCodex
    ? [
      '- Auth: the container holds only a single-invocation broker ticket. The real bearer and ChatGPT-Account-ID are attached host-side by the Codex broker and are unreadable from the sandbox shell, env, argv, /proc, workspace or logs.',
      '- CODEX_HOME is a throwaway directory outside /workspace, removed in finally; .codex state never enters the listing, snapshot or harvest.',
      '- After exit: harvest every regular file under /workspace/ into the delivery buffer.',
      `- Tool result includes free-text agent reply + delivery_note: ${DELIVERY_SELECTION_NOTICE}`,
      '- No structured JSON schema for build attachments; GemiX-Main selects final user files.'
    ]
    : [
      '- Auth: host getXaiAuth().token injected as XAI_API_KEY for this exec only (no host ~/.hermes mount).',
      '- After exit: harvest every regular file under /workspace/ into the delivery buffer.',
      `- Tool result includes free-text agent reply + delivery_note: ${DELIVERY_SELECTION_NOTICE}`,
      '- No structured JSON schema for build attachments; GemiX-Main selects final user files.'
    ];

  const credentialError = runner.credentialError('<reason>');
  return [
    `=== BUILD SUB-AGENT (${runner.label} in Docker: rules + exec contract) ===`,
    '',
    '--- DEVELOPER INSTRUCTIONS ---',
    rules,
    '',
    '--- EXEC (argv, secrets redacted) ---',
    `cmd: ${JSON.stringify(spec.cmd)}`,
    `env: ${JSON.stringify(redactedEnv)}`,
    `timeoutMs: ${spec.timeoutMs}`,
    '',
    '--- HOST CONTRACT ---',
    ...hostContract,
    '',
    '--- TOOL ERRORS (host) ---',
    '    build:',
    '        - Cannot resolve requested attachment(s): <names>',
    '        - build is busy: another request is using this workspace.',
    `        - ${credentialError}`,
    `        - ${runner.label} failed to start or run: <reason>`,
    '        - Build hard timeout (<N>s).'
  ].join('\n');
}

export { renderCase, renderBuildAgentDump };
