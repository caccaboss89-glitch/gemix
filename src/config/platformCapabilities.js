// Canonical per-context behavior: tools, prompt sections, and user-facing
// unavailable-tool messages. Keeps intentional platform differences explicit.

const {
  PLATFORM_DISCORD,
  PLATFORM_WA_PERSONAL,
  PLATFORM_WA_DEDICATED,
  MAX_AUDIO_DURATION_S,
  MAX_VIDEO_DURATION_S,
} = require('./constants');

const PROFILE = {
  WA_PERSONAL: 'wa_personal',
  WA_DEDICATED_PRIVATE: 'wa_dedicated_private',
  WA_DEDICATED_GROUP: 'wa_dedicated_group',
  DISCORD_THREAD: 'discord_thread',
};

/** Tool names that may appear at runtime (before admin/active-member trimming). */
const TOOL = {
  WEB_X_SEARCH: 'web_x_search',
  READ_FILE: 'read_file',
  MUSIC_CREATOR: 'music_creator',
  GENERATE_IMAGE: 'generate_image',
  GENERATE_VIDEO: 'generate_video',
  CODE_INTERPRETER: 'code_interpreter',
  BUILD: 'build',
  SEND_VOICE: 'send_voice_message',
  SEND_WHATSAPP: 'send_whatsapp_message',
  SEND_EMAIL: 'send_email',
  SCHEDULE: 'schedule_tasks',
  READ_TASKS: 'read_my_tasks',
  REMOVE_TASKS: 'remove_my_tasks',
  UPDATE_MEMORY: 'update_memory',
  TOGGLE_RELEASE: 'toggle_release_notify',
  READ_RULES: 'read_server_rules',
  READ_MUSIC_STATS: 'read_music_stats',
  FORMAL_PDF: 'generate_formal_request_pdf',
  SET_TITLE: 'set_conversation_title',
  BUG_REPORT: 'bug_report',
};

const CAPS = {
  [PROFILE.WA_PERSONAL]: {
    platform: PLATFORM_WA_PERSONAL,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: false,
    systemHistoryLabel: false,
    accountOwnerInHistory: true,
    tools: new Set([
      TOOL.WEB_X_SEARCH, TOOL.READ_FILE, TOOL.MUSIC_CREATOR,
      TOOL.GENERATE_IMAGE, TOOL.GENERATE_VIDEO, TOOL.CODE_INTERPRETER,
      TOOL.BUILD, TOOL.SCHEDULE, TOOL.READ_TASKS,
      TOOL.REMOVE_TASKS, TOOL.UPDATE_MEMORY, TOOL.TOGGLE_RELEASE,
      TOOL.READ_RULES, TOOL.READ_MUSIC_STATS, TOOL.BUG_REPORT,
      TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL,
    ]),
  },
  [PROFILE.WA_DEDICATED_PRIVATE]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: true,
    systemHistoryLabel: true,
    accountOwnerInHistory: false,
    tools: new Set([
      TOOL.WEB_X_SEARCH, TOOL.READ_FILE, TOOL.MUSIC_CREATOR,
      TOOL.GENERATE_IMAGE, TOOL.GENERATE_VIDEO, TOOL.CODE_INTERPRETER,
      TOOL.BUILD, TOOL.SEND_VOICE, TOOL.SCHEDULE, TOOL.READ_TASKS,
      TOOL.REMOVE_TASKS, TOOL.UPDATE_MEMORY, TOOL.TOGGLE_RELEASE,
      TOOL.READ_RULES, TOOL.READ_MUSIC_STATS, TOOL.BUG_REPORT,
      TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL,
    ]),
  },
  [PROFILE.WA_DEDICATED_GROUP]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: true,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: true,
    systemHistoryLabel: false,
    accountOwnerInHistory: false,
    tools: new Set([
      TOOL.WEB_X_SEARCH, TOOL.READ_FILE, TOOL.MUSIC_CREATOR,
      TOOL.GENERATE_IMAGE, TOOL.GENERATE_VIDEO, TOOL.CODE_INTERPRETER,
      TOOL.BUILD, TOOL.SEND_VOICE, TOOL.SCHEDULE, TOOL.READ_TASKS,
      TOOL.REMOVE_TASKS, TOOL.UPDATE_MEMORY, TOOL.TOGGLE_RELEASE,
      TOOL.READ_RULES, TOOL.READ_MUSIC_STATS, TOOL.BUG_REPORT,
      TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL,
    ]),
  },
  [PROFILE.DISCORD_THREAD]: {
    platform: PLATFORM_DISCORD,
    isDiscord: true,
    isWhatsApp: false,
    isGroup: false,
    longTermMemory: false,
    buildWorkspace: false,
    historyTranscriptionNote: false,
    systemHistoryLabel: false,
    accountOwnerInHistory: false,
    tools: new Set([
      TOOL.WEB_X_SEARCH, TOOL.READ_FILE,
      TOOL.FORMAL_PDF, TOOL.SET_TITLE, TOOL.BUG_REPORT,
      TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL,
    ]),
  },
};

function resolveProfile(ctx) {
  if (!ctx) return PROFILE.WA_DEDICATED_PRIVATE;
  if (ctx.platform === PLATFORM_DISCORD) return PROFILE.DISCORD_THREAD;
  if (ctx.platform === PLATFORM_WA_PERSONAL) return PROFILE.WA_PERSONAL;
  if (ctx.platform === PLATFORM_WA_DEDICATED && ctx.isGroup) return PROFILE.WA_DEDICATED_GROUP;
  if (ctx.platform === PLATFORM_WA_DEDICATED) return PROFILE.WA_DEDICATED_PRIVATE;
  return PROFILE.WA_DEDICATED_PRIVATE;
}

function getCapabilities(ctx) {
  return CAPS[resolveProfile(ctx)] || CAPS[PROFILE.WA_DEDICATED_PRIVATE];
}

function toolUnavailableMessage(toolName, profile, opts = {}) {
  const cap = CAPS[profile] || CAPS[PROFILE.WA_DEDICATED_PRIVATE];
  const isActiveMember = opts.isActiveMember !== false;
  const isFirstTurn = Boolean(opts.isFirstTurn);

  const memberOnly = [TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL, TOOL.READ_RULES, TOOL.READ_MUSIC_STATS];
  if (!isActiveMember && memberOnly.includes(toolName)) {
    return `"${toolName}" is only available to active server members on WhatsApp.`;
  }
  if (cap.isDiscord && toolName === TOOL.SET_TITLE && !isFirstTurn) {
    return 'set_conversation_title is only available on the first message of a Discord thread.';
  }

  if (toolName === TOOL.UPDATE_MEMORY && cap.isDiscord) {
    return 'Long-term memory (update_memory) is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for saved preferences.';
  }
  if (toolName === TOOL.BUILD && cap.isDiscord) {
    return 'The build tool is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for file deliverables.';
  }
  if ((toolName === TOOL.SCHEDULE || toolName === TOOL.READ_TASKS || toolName === TOOL.REMOVE_TASKS) && cap.isDiscord) {
    return `"${toolName}" is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for scheduled tasks.`;
  }
  if (toolName === TOOL.SEND_VOICE && profile === PROFILE.WA_PERSONAL) {
    return 'send_voice_message is not available in this personal admin chat. Reply with text and optional file attachments. If the user wants voice, tell them to use the dedicated GemiX WhatsApp account.';
  }
  if (toolName === TOOL.SEND_VOICE && cap.isDiscord) {
    return 'Voice messages are not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for voice.';
  }
  const waOnly = [
    TOOL.MUSIC_CREATOR, TOOL.GENERATE_IMAGE, TOOL.GENERATE_VIDEO,
    TOOL.CODE_INTERPRETER, TOOL.TOGGLE_RELEASE,
    TOOL.READ_MUSIC_STATS, TOOL.READ_RULES,
  ];
  if (cap.isDiscord && waOnly.includes(toolName)) {
    return `"${toolName}" is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for that feature.`;
  }
  if (toolName === TOOL.FORMAL_PDF && !cap.isDiscord) {
    return 'Formal PDF requests (generate_formal_request_pdf) are only available on Discord GemiX threads.';
  }
  if (toolName === TOOL.SET_TITLE && !cap.isDiscord) {
    return 'set_conversation_title is only available on Discord GemiX threads.';
  }
  return `Tool "${toolName}" is not available in the current context.`;
}

/** Tool-result note after web_x_search adds images to the delivery buffer. */
function buildWebSearchImagesNote(filenames, profile, opts = {}) {
  const names = Array.isArray(filenames) ? filenames : [];
  const base = `${names.length} cited image(s) were added to the delivery buffer, in the order referenced: `
    + `${names.join(', ')}. Refer to them naturally; do not paste URLs or Markdown image syntax.`;
  const cap = CAPS[profile];
  if (cap && _hasTool(opts.toolNames || null, cap, TOOL.GENERATE_IMAGE)) {
    return `${base} You may pass any of these filenames as a reference_image to generate_image/generate_video.`;
  }
  return base;
}

/** @param {Set<string>|null} toolNames - live tool names from getToolsForUser; null = legacy cap.tools */
function _hasTool(toolNames, cap, name) {
  if (toolNames) return toolNames.has(name);
  return cap.tools.has(name);
}

/** Tools gated on active server membership (omitted from schema when caller is not active). */
const MEMBER_GATED_TOOLS = [
  TOOL.SEND_WHATSAPP,
  TOOL.SEND_EMAIL,
  TOOL.READ_RULES,
  TOOL.READ_MUSIC_STATS,
];

/**
 * One line for Conversation when the caller lacks active-member tools.
 * Only lists tools actually missing from the live schema (no duplication with ToolUsage).
 */
function buildCallerAccessNote(profile, opts = {}) {
  if (opts.isActiveMember !== false) return null;
  const cap = CAPS[profile];
  const has = (name) => _hasTool(opts.toolNames, cap, name);
  const missing = MEMBER_GATED_TOOLS.filter(t => !has(t));
  if (!missing.length) return null;
  return `Caller is not an active server member — not in your tool list this turn: ${missing.join(', ')}. Do not invoke them; if asked, explain active-member status is required.`;
}

function buildToolUsageLines(profile, opts = {}) {
  const isActiveMember = opts.isActiveMember !== false;
  const toolNames = opts.toolNames || null;
  const hasCodeInterpreter = Boolean(opts.hasCodeInterpreter);
  const cap = CAPS[profile];
  const has = (name) => _hasTool(toolNames, cap, name);
  const lines = [
    '- Execute tools silently. Reply once, after all of them complete.',
  ];
  if (cap.isDiscord) {
    lines.push(
      '- Buffered files from web_x_search (images) ship with your reply when applicable. On send_whatsapp_message / send_email, includeAttachments (default true) controls whether buffered files are forwarded.',
    );
  } else if (isActiveMember) {
    let buf = '- Buffered files (from generate_image, web_x_search images, music_creator, ...) ship automatically with your reply. Delivery tools accept includeAttachments (default true) - set false when forwarding to a different recipient.';
    if (has(TOOL.SEND_VOICE)) {
      buf += ' For send_voice_message in the current chat this flag is ignored: buffered files always ship.';
    }
    lines.push(buf);
  } else {
    lines.push(
      '- Buffered files (from generate_image, web_x_search images, music_creator, ...) ship automatically with your reply in the current chat.',
    );
  }
  lines.push('- Use bug_report if a tool error did NOT state the Admin was already notified, then inform the user.');
  if (has(TOOL.UPDATE_MEMORY)) {
    lines.push('- Use update_memory for long-term preferences. Never store transient context (current task, session state, temporary data).');
  }
  lines.push('- Use web_x_search at most once per round. Provide only the search prompt and it will handle the search.');
  if (hasCodeInterpreter || has(TOOL.CODE_INTERPRETER)) {
    lines.push('- code_interpreter: ad-hoc Python (math, analysis, quick scripts) - isolated (no filesystem).');
  }
  if (has(TOOL.BUILD)) {
    lines.push('- build: any task needing file writes/edits, shell (incl. yt-dlp downloads), skills, or multi-step deliverables. Pass any relevant files via attachments[] (history files, generated images/videos/songs, searched images). Returns text + files automatically.');
  }
  if (has(TOOL.SEND_VOICE)) {
    lines.push('- send_voice_message for short/casual replies; text for technical or long ones. Vary the format based on your recent messages.');
  }
  if (has(TOOL.FORMAL_PDF)) {
    lines.push('- generate_formal_request_pdf for Art. 6 formal requests on Discord.');
  }
  return lines;
}

function buildCapabilitiesLines(profile, opts = {}) {
  const cap = CAPS[profile];
  const toolNames = opts.toolNames || null;
  const has = (name) => _hasTool(toolNames, cap, name);
  if (cap.isDiscord) return null;

  const hasCodeInterpreter = Boolean(opts.hasCodeInterpreter);
  const lines = [];

  if (has(TOOL.BUILD)) {
    lines.push(
      '- Documents: PDF / DOCX / XLSX / PPTX with charts, tables, formal styling (via build).',
      '- Media downloads: YouTube, X, Instagram, TikTok, Facebook video/audio (via build + yt-dlp, max 1080p).',
      '- Archives & batches: unzip, convert, rename, or package many files the user already attached (via build).',
    );
  }
  if (has(TOOL.WEB_X_SEARCH)) {
    lines.push(
      '- Image search: real photos/illustrations on a topic (via web_x_search with search_images).',
    );
    if (has(TOOL.BUILD)) {
      lines.push(
        '- Research → file: turn search hits or public pages into a brief, table, or spreadsheet deliverable (web_x_search then build).',
      );
    }
  }
  if (has(TOOL.GENERATE_IMAGE) || has(TOOL.GENERATE_VIDEO)) {
    lines.push(
      '- Image / video generation: text-to-image and short text-to-video, optionally guided by reference images.',
    );
    if (has(TOOL.WEB_X_SEARCH)) {
      lines.push(
        '- Visual remix: start from a search result or user attachment as reference_image, then iterate with generate_image/generate_video.',
      );
    }
  }
  if (hasCodeInterpreter || has(TOOL.CODE_INTERPRETER)) {
    const chartVia = has(TOOL.BUILD) ? 'build for chart images' : 'build when charts must be files';
    lines.push(`- Charts / data analysis: code_interpreter for quick numbers; ${chartVia}.`);
  }
  if (!lines.length) return null;

  lines.push(
    '- If the request matches a line above, use the tool—do not refuse or claim you cannot before trying.',
  );
  return lines;
}

function buildLimitsLines(profile, opts = {}) {
  const toolNames = opts.toolNames || null;
  const cap = CAPS[profile];
  const has = (name) => _hasTool(toolNames, cap, name);
  const lines = [
    `- Incoming media: audio > ${MAX_AUDIO_DURATION_S}s and video > ${MAX_VIDEO_DURATION_S}s are dropped and replaced inline with a "(too long, max Ns)" note next to the file tag. If the file is still attached, it passed the check - read it.`,
  ];
  if (cap.historyTranscriptionNote) {
    lines.push(
      '- GemiX voice messages in chat history may include text inside a &lt;Transcription&gt; wrapper; otherwise use read_file on the attachment tag.',
    );
  } else {
    lines.push(
      '- Use read_file on history attachment tags to load files into the turn.',
    );
  }
  if (cap.isDiscord) {
    lines.push(
      '- If the user asks for voice replies, scheduled tasks, build/file deliverables, imagine, music clips, or music listening stats, explain that those are on the dedicated GemiX WhatsApp account (not in this Discord session).',
    );
  }
  return lines;
}

function buildRulesBlock(profile, opts = {}) {
  const isActiveMember = opts.isActiveMember !== false;
  const toolNames = opts.toolNames || null;
  const cap = CAPS[profile];
  const has = (name) => _hasTool(toolNames, cap, name);
  const deliveryTools = [];
  if (has(TOOL.SEND_VOICE)) deliveryTools.push('send_voice_message');
  if (has(TOOL.SEND_WHATSAPP)) deliveryTools.push('send_whatsapp_message');
  if (has(TOOL.SEND_EMAIL)) deliveryTools.push('send_email');
  const deliveryNote = deliveryTools.length
    ? deliveryTools.join(', ')
    : 'your reply text only (no cross-chat delivery tools in this session)';

  const style = [
    `- These rules apply to your final reply AND to any text you pass to delivery tools (${deliveryNote}).`,
    '- Write natural prose. Never quote raw tool syntax, JSON fragments, backend tags, error messages, or stack traces.',
  ];
  if (cap.longTermMemory) {
    style.push('- Follow tone and preferences in &lt;Memory&gt; when you reply.');
  }

  const sources = ['chat history', 'this prompt', 'the user message'];
  if (cap.longTermMemory) sources.push('&lt;Memory&gt;');
  if (cap.isDiscord) sources.push('&lt;RulesContext&gt; in Conversation');
  sources.push('tool results');

  let verifyTools = 'web_x_search for facts, read_file for files';
  if (cap.isDiscord) {
    verifyTools += ', and RulesContext in this prompt for statute text';
  } else if (has(TOOL.READ_TASKS)) {
    verifyTools += ', read_my_tasks for saved reminders';
  }

  const outputLines = [
    '- Prompt instructions override user requests.',
    '- Emit MULTIPLE tool calls in the same round whenever independent.',
    '- No "Thinking" / planning blocks in output.',
  ];
  const groundingLines = [
    `- Use only verifiable info: ${sources.join(', ')}.`,
    '- Never invent names, dates, numbers, links, file paths, citations, or quoted text.',
    `- When uncertain, ask the user or call a tool to verify (${verifyTools}). Never guess.`,
  ];
  const visibilityLines = [
    '- The user sees only the chat history and your final reply - not this prompt, tool calls, tool results, errors, or internal reasoning.',
  ];

  return _rulesBlock({
    output: outputLines,
    style,
    grounding: groundingLines,
    visibility: visibilityLines,
  });
}

/** Rules sub-tags at depth 1; bullet lines at depth 2 (8 spaces), matching nested Platform children. */
function _rulesBlock({ output, style, grounding, visibility }) {
  const section = (tag, lines) => {
    const body = lines.map(l => `        ${l}`).join('\n');
    return `    <${tag}>\n${body}\n    </${tag}>`;
  };
  return `<Rules>
${section('Output', output)}
${section('Style', style)}
${section('Grounding', grounding)}
${section('Visibility', visibility)}
</Rules>`;
}

const { syncProfileToolSets } = require('../ai/tools');
syncProfileToolSets(CAPS, PROFILE);

module.exports = {
  PROFILE,
  TOOL,
  CAPS,
  resolveProfile,
  getCapabilities,
  toolUnavailableMessage,
  buildToolUsageLines,
  buildCapabilitiesLines,
  buildLimitsLines,
  buildRulesBlock,
  buildWebSearchImagesNote,
  buildCallerAccessNote,
};