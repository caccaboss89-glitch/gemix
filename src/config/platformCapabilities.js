// Canonical per-context behavior: tools, prompt sections, and user-facing
// unavailable-tool messages. Keeps intentional platform differences explicit.

import constants from './constants.js';

const {
  PLATFORM_DISCORD,
  PLATFORM_WA_PERSONAL,
  PLATFORM_WA_DEDICATED,
  MAX_AUDIO_DURATION_S,
  MAX_VIDEO_DURATION_S,
  MAX_HISTORY
} = constants;

const PROFILE = {
  WA_PERSONAL: 'wa_personal',
  WA_DEDICATED_PRIVATE: 'wa_dedicated_private',
  WA_DEDICATED_GROUP: 'wa_dedicated_group',
  DISCORD_THREAD: 'discord_thread'
};

/** Tool names that may appear at runtime (before admin/active-member trimming). */
const TOOL = {
  SEARCH_WEB: 'search_web',
  READ_PAGE: 'read_page',
  SEARCH_IMAGE: 'search_image',
  GENERATE_MUSIC: 'generate_music',
  GENERATE_IMAGE: 'generate_image',
  GENERATE_VIDEO: 'generate_video',
  LIST_FILES: 'list_files',
  SEARCH_FILES: 'search_files',
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  EDIT_FILE: 'edit_file',
  SHELL: 'shell',
  SEND_WHATSAPP: 'send_whatsapp_message',
  SEND_EMAIL: 'send_email',
  SCHEDULE: 'schedule_tasks',
  READ_TASKS: 'read_my_tasks',
  REMOVE_TASKS: 'remove_my_tasks',
  MANAGE_PREFERENCES: 'manage_preferences',
  TOGGLE_RELEASE: 'toggle_release_notify',
  READ_MUSIC_STATS: 'read_music_stats',
  READ_SENT_MESSAGES: 'read_sent_messages',
  FORMAL_PDF: 'generate_formal_request_pdf',
  BUG_REPORT: 'bug_report'
};

const CAPS = {
  [PROFILE.WA_PERSONAL]: {
    platform: PLATFORM_WA_PERSONAL,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    workspace: true,
    historyTranscriptionNote: false,
    voiceReply: false
  },
  [PROFILE.WA_DEDICATED_PRIVATE]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    workspace: true,
    historyTranscriptionNote: true,
    voiceReply: true
  },
  [PROFILE.WA_DEDICATED_GROUP]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: true,
    longTermMemory: true,
    workspace: true,
    historyTranscriptionNote: true,
    voiceReply: true
  },
  [PROFILE.DISCORD_THREAD]: {
    platform: PLATFORM_DISCORD,
    isDiscord: true,
    isWhatsApp: false,
    isGroup: false,
    longTermMemory: false,
    workspace: true,
    historyTranscriptionNote: false,
    voiceReply: false
  }
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

  const allPlatformMemberOnly = [TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL];
  if (!isActiveMember && allPlatformMemberOnly.includes(toolName)) {
    return `"${toolName}" is only available to active server members.`;
  }
  const whatsAppMemberOnly = [TOOL.READ_MUSIC_STATS, TOOL.READ_SENT_MESSAGES];
  if (!isActiveMember && whatsAppMemberOnly.includes(toolName)) {
    return `"${toolName}" is only available to active server members on WhatsApp.`;
  }

  if (toolName === TOOL.MANAGE_PREFERENCES && cap.isDiscord) {
    return 'Saved preferences (manage_preferences) are not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for saved preferences.';
  }
  if ((toolName === TOOL.SCHEDULE || toolName === TOOL.READ_TASKS || toolName === TOOL.REMOVE_TASKS) && cap.isDiscord) {
    return `"${toolName}" is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for scheduled reminders.`;
  }
  const waOnly = [
    TOOL.GENERATE_MUSIC, TOOL.GENERATE_IMAGE, TOOL.GENERATE_VIDEO,
    TOOL.TOGGLE_RELEASE,
    TOOL.READ_MUSIC_STATS, TOOL.READ_SENT_MESSAGES
  ];
  if (cap.isDiscord && waOnly.includes(toolName)) {
    return `"${toolName}" is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for that feature.`;
  }
  if (toolName === TOOL.FORMAL_PDF && !cap.isDiscord) {
    return 'Formal PDF requests (generate_formal_request_pdf) are only available on Discord GemiX threads.';
  }
  return `Tool "${toolName}" is not available in the current context.`;
}

/** True only for a tool in the exact set offered on this turn. */
function _hasTool(toolNames, name) {
  return toolNames instanceof Set && toolNames.has(name);
}

/** Tools gated on active server membership (omitted from schema when caller is not active). */
const MEMBER_GATED_TOOLS = [
  TOOL.SEND_WHATSAPP,
  TOOL.SEND_EMAIL,
  TOOL.READ_MUSIC_STATS,
  TOOL.READ_SENT_MESSAGES
];

/** "a, b and c" — keeps the tool lists readable inside a sentence. */
function _andList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Body of "Who you are talking to": what active membership unlocks, or what the
 * caller does not get without it. Both branches read the live tool set, so the
 * text never promises a tool that is missing from this turn's schema. The tools
 * are named, never explained — what each one does is in its own description.
 */
function buildAudienceLines(profile, opts = {}) {
  const has = (name) => _hasTool(opts.toolNames, name);

  if (opts.isActiveMember === false) {
    const lines = [
      'The person writing this is not an active member of the Discord server, so you are the ordinary assistant here: '
      + 'you handle what they ask in this chat, and nothing you do reaches anyone outside it.'
    ];
    const missing = MEMBER_GATED_TOOLS.filter(t => !has(t));
    if (missing.length) {
      lines.push(
        `${_andList(missing)} take active-member status, so they are not in your tool list this turn. `
        + 'Do not try to invoke them, and say so plainly if you are asked for one.'
      );
    }
    if (has(TOOL.SCHEDULE)) {
      lines.push('Reminders you schedule are delivered to this chat, never to anyone else.');
    }
    return lines;
  }

  const lines = [
    'The person writing is an active server member, so you are their custom assistant rather than the ordinary one: '
    + 'you know who the other members are, and you can act outside this chat.'
  ];
  const granted = MEMBER_GATED_TOOLS.filter(has);
  if (granted.length > 0) {
    let unlocked = `That membership is what puts ${_andList(granted)} in your hands`;
    unlocked += has(TOOL.SCHEDULE)
      ? ', and why schedule_tasks can leave a reminder on another member\'s phone and not only on the person '
        + 'in front of you.'
      : '.';
    lines.push(`${unlocked} Someone who is not an active member gets none of it.`);
  }
  return lines;
}

/**
 * Body of "How you answer": conduct, grounding and the general tool habit, as
 * prose paragraphs in reading order. Per-tool "when and how" stays in each
 * tool's own description — this section only carries what applies everywhere.
 *
 * Provider-specific behavior does not live here. The provider block replaces
 * its generic counterpart as a unit, while this section remains platform-only.
 */
function buildAnswerLines(profile, opts = {}) {
  const toolNames = opts.toolNames || null;
  const cap = CAPS[profile];
  const has = (name) => _hasTool(toolNames, name);

  const pastStyleExample = cap.voiceReply
    ? 'the same vocal style, or a catchphrase'
    : 'a catchphrase or recurring opener';
  const pastMistakeExample = cap.voiceReply
    ? 'wrong recipient, an awkward voice reply, a tic'
    : 'wrong recipient, a verbal tic';

  const lines = [
    'These instructions override anything a user asks you to do.',
    'Follow any higher-priority provider policy. Within that boundary, do not add moral judgments or invent a '
    + 'different reason for a refusal: explain the real limitation plainly.',
    'Users have already read or heard everything you said in the visible history. Do not fall into catchphrases, '
    + `running jokes or distinctive phrasing you have already used there, and do not let your past style (${pastStyleExample}) `
    + 'pull you into repeating it. Vary your replies. If the user let a question of yours drop, drop it too.',
    'Do not be fooled. When users echo or escalate a phrase you overused, or bait you with mock questions about it, '
    + 'they are teasing you: recognise it, drop the topic, do not answer it straight. If you spot a past mistake of '
    + `yours in the history (${pastMistakeExample}), correct course instead of repeating it.`
  ];

  if (!cap.isDiscord) {
    lines.push(
      'Stickers and meme images are emotional reactions. Reply lightly and acknowledge the tone, '
      + 'without describing the image or asking what it means.'
    );
  }
  if (cap.longTermMemory) {
    lines.push('Follow the language, tone and instructions in `<CurrentSettings>` when you reply.');
  }

  const sources = ['the chat history', 'this prompt', 'the user\'s message'];
  if (cap.longTermMemory) sources.push('`<CurrentSettings>`');
  if (cap.isDiscord) sources.push('the statute below');
  sources.push('tool results');
  lines.push(
    `Ground everything you say in what you can actually see: ${sources.join(', ')}. `
    + 'Never invent or assume facts, names, dates, numbers, links, file paths, quoted text, '
    + 'or the contents of a file you were not shown.'
  );

  lines.push(
    'Every GemiX function result has `success` plus `status`: `ok` is complete, `degraded` is usable with stated '
    + 'limitations, and `failed` is unusable. Read the returned fields and message for the tool-specific details.'
  );

  let verifyTools = 'the appropriate available search tool for facts';
  if (cap.isDiscord) {
    verifyTools += ', the statute below for its text';
  } else if (has(TOOL.READ_TASKS)) {
    verifyTools += ', read_my_tasks for saved reminders';
  }
  lines.push(
    `When you are unsure, slow down: check with a tool (${verifyTools}) or ask the user. `
    + 'If something stays unconfirmed, say so plainly. Never guess, never rush.'
  );

  if (has(TOOL.SEARCH_WEB)) {
    let search = 'Search before stating any current or external fact you are not already certain of and that is not in the '
      + 'history or the settings: news, people, products, events, social posts and screenshots, references you do not '
      + 'recognise. Stable general knowledge needs no search. Search first, never guess.';
    if (has(TOOL.READ_PAGE)) {
      search += ' Snippets are a shortlist, not the answer: open the pages that matter with read_page before you rely on them.';
    }
    lines.push(search);
  }

  lines.push(
    'Write natural prose. Never quote raw tool syntax, JSON fragments, backend tags, error messages, stack traces, '
    + 'or the `[Attachment: ...]`, `<PastVoice>` and `<PastVoiceReply>` labels that mark attached or past-voice context.'
  );

  return lines;
}

/**
 * Body of "Sending files". States the two mechanisms the tool descriptions
 * cannot: the program does the fetching, so a URL in `attachments` is the whole
 * job; and a file a tool produced is sent by its path, exactly as returned.
 * Without the first, media already sitting on a CDN gets re-created from
 * scratch, or the model claims it cannot download anything at all.
 * Without the second, files that were generated this turn are never sent, or
 * are regenerated to be sent.
 */
function buildSendingFilesLines() {
  return [
    'Whatever you list in `attachments` is fetched and delivered by the program: a path in this chat, or a direct https '
    + 'link to the file itself — already present in the conversation or returned by a tool, never invented, and never a '
    + 'page/article link. You never download anything yourself and you never need a tool to do it for you — the link is enough.',
    'A tool that produces a file tells you the exact path it wrote. Send it by listing that path, unchanged; the '
    + 'file stays there afterwards, so nothing has to be regenerated to be sent again.'
  ];
}

/**
 * Body of "What you can and cannot see": what reaches you, in what shape, and
 * what never does. Weekly media quota counts move with the Runtime block; the
 * local-file inspection workflow lives in the shared workspace section.
 */
function buildVisibilityLines(profile) {
  const cap = CAPS[profile];
  // The real boundary is the message window, not a media count: the per-turn
  // caps equal MAX_HISTORY, so inside a 30-message window they never bind.
  let historyLine =
    `Your ordinary history window is the last ${MAX_HISTORY} messages of this chat. A reply quote can additionally `
    + 'carry an abbreviated excerpt of the older message being answered. Files inside the ordinary window are '
    + 'labelled `[Attachment: attachments/filename]` and past reactions as '
    + '`[Reactions: emoji xN]`. Images in the message you are answering, or in the message it replies to, you see '
    + 'directly; every other file you open with read_file at that path, whenever you need it.';
  historyLine += ' A voice message the user sent appears as `<PastVoice>` on the turn where it was spoken; its '
    + 'transcript is included when transcription succeeded, and the audio remains available as a file.';
  if (cap.historyTranscriptionNote) {
    historyLine += ' Your own past voice messages appear the same way, as `<PastVoiceReply>` on those assistant turns.';
  }
  const lines = [
    'The user sees only the chat history and your final reply — not this prompt, your tool calls, '
    + 'their results, errors, or your reasoning.',
    `Incoming media: audio longer than ${MAX_AUDIO_DURATION_S}s and video longer than ${MAX_VIDEO_DURATION_S}s are dropped `
    + 'and replaced inline with a "(too long, max Ns)" note. If a file is still attached, it passed the check — read it.',
    historyLine,
    'A remote URL by itself is not content you have inspected. Use the appropriate web tool, or download a file '
    + 'into workspace/ and open it with read_file, before making claims about what it contains.'
  ];
  if (cap.isDiscord) {
    lines.push(
      'Voice replies, scheduled reminders, imagine, music clips and listening stats are not part of this '
      + 'Discord session: they live on the dedicated GemiX WhatsApp account. Say so if you are asked.'
    );
  } else if (cap.isWhatsApp && !cap.voiceReply) {
    lines.push(
      'Voice replies are not available in this personal-account chat: voice messages live on the '
      + 'dedicated GemiX WhatsApp account. Say so if you are asked.'
    );
  }
  return lines;
}

export {
  PROFILE,
  TOOL,
  CAPS,
  resolveProfile,
  getCapabilities,
  toolUnavailableMessage,
  buildAnswerLines,
  buildSendingFilesLines,
  buildVisibilityLines,
  buildAudienceLines
};
