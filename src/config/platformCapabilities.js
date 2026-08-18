// Canonical per-context behavior: tools, prompt sections, and user-facing
// unavailable-tool messages. Keeps intentional platform differences explicit.
//
// The effective capability set for a turn is the intersection of three axes —
// provider × platform × membership/admin. getCapabilities(ctx) resolves it once
// and every consumer (prompt, tool registry, response schema, dispatcher gate,
// Runtime quotas, unavailable messages, footer) reads it instead of testing the
// provider on its own. There is no second, hand-kept list anywhere.

import constants from './constants.js';
import { profileFromContext, PROVIDER } from '../ai/providers/providerProfile.js';

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
  WEB_SEARCH: 'web_search',
  X_SEARCH: 'x_search',
  WEB_IMAGE_SEARCH: 'web_image_search',
  READ_VIDEO: 'read_video',
  GENERATE_MUSIC: 'generate_music',
  GENERATE_IMAGE: 'generate_image',
  GENERATE_VIDEO: 'generate_video',
  BUILD: 'build',
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

// `toolsByProvider` is not written here: syncProfileToolSets() fills it at the
// bottom of this file straight from the tool registry, so a profile's
// capability set can never drift from what getToolsForUser actually returns.
const CAPS = {
  [PROFILE.WA_PERSONAL]: {
    platform: PLATFORM_WA_PERSONAL,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: false,
    voiceReply: false,
    toolsByProvider: null
  },
  [PROFILE.WA_DEDICATED_PRIVATE]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: false,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: true,
    voiceReply: true,
    toolsByProvider: null
  },
  [PROFILE.WA_DEDICATED_GROUP]: {
    platform: PLATFORM_WA_DEDICATED,
    isDiscord: false,
    isWhatsApp: true,
    isGroup: true,
    longTermMemory: true,
    buildWorkspace: true,
    historyTranscriptionNote: true,
    voiceReply: true,
    toolsByProvider: null
  },
  [PROFILE.DISCORD_THREAD]: {
    platform: PLATFORM_DISCORD,
    isDiscord: true,
    isWhatsApp: false,
    isGroup: false,
    longTermMemory: false,
    buildWorkspace: false,
    historyTranscriptionNote: false,
    voiceReply: false,
    toolsByProvider: null
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

/** Memoized per (platform profile × provider) — both are fixed for a process. */
const _mergedCaps = new Map();

/**
 * The effective capabilities for a context: the platform profile intersected
 * with what the active provider can actually do. Consumers read the merged
 * flags (`voiceReply`, `readVideo`, …) and never test the provider themselves.
 * @param {object} ctx - handler ctx / userCtx (carries platform + providerProfile)
 * @returns {object} frozen capability set
 */
function getCapabilities(ctx) {
  const platformProfile = resolveProfile(ctx);
  const provider = profileFromContext(ctx);
  const key = `${platformProfile}\0${provider.id}`;
  const cached = _mergedCaps.get(key);
  if (cached) return cached;

  const base = CAPS[platformProfile] || CAPS[PROFILE.WA_DEDICATED_PRIVATE];
  const can = provider.capabilities;
  const merged = Object.freeze({
    ...base,
    provider,
    providerId: provider.id,
    tools: base.toolsByProvider?.[provider.id] || new Set(),
    // Platform decides whether a voice reply is possible at all; the provider
    // decides whether a voice can be named and whether user audio reaches the
    // model as sound or as an external transcript.
    voiceReply: base.voiceReply && can.voiceReply,
    namedVoices: base.voiceReply && can.namedVoices,
    userVoiceTranscription: can.userVoiceTranscription,
    // GemiX's own past voice notes are replayed as text on every voice platform,
    // whichever provider produced them.
    historyTranscriptionNote: base.historyTranscriptionNote,
    xSearch: can.xSearch,
    readVideo: can.readVideo,
    generateVideo: can.generateVideo,
    generateImage: can.generateImage,
    hostedWebSearch: can.hostedWebSearch,
    imageSearch: can.imageSearch,
    nativeAudioInput: can.nativeAudioInput,
    nativeVideoInput: can.nativeVideoInput
  });
  _mergedCaps.set(key, merged);
  return merged;
}

function toolUnavailableMessage(toolName, profile, opts = {}) {
  const cap = CAPS[profile] || CAPS[PROFILE.WA_DEDICATED_PRIVATE];
  const provider = profileFromContext(opts);
  const isActiveMember = opts.isActiveMember !== false;

  const memberOnly = [TOOL.SEND_WHATSAPP, TOOL.SEND_EMAIL, TOOL.READ_MUSIC_STATS, TOOL.READ_SENT_MESSAGES];
  if (!isActiveMember && memberOnly.includes(toolName)) {
    return `"${toolName}" is only available to active server members on WhatsApp.`;
  }

  // Capabilities the selected back end does not have at all. Stated as a
  // property of this GemiX deployment, never as something the user can switch.
  const providerMissing = {
    [TOOL.X_SEARCH]: !provider.capabilities.xSearch,
    [TOOL.READ_VIDEO]: !provider.capabilities.readVideo,
    [TOOL.GENERATE_VIDEO]: !provider.capabilities.generateVideo
  };
  if (providerMissing[toolName]) {
    if (provider.id === PROVIDER.OPENAI) {
      return 'X search and video understanding or generation are unavailable because the administrator configured '
        + 'GemiX with ChatGPT; users cannot change that setting.';
    }
    return `"${toolName}" does not exist on ${provider.displayName}, which is the model this GemiX runs on. `
      + 'Tell the user plainly that this feature is not available here; it is not something they can turn on.';
  }

  if (toolName === TOOL.MANAGE_PREFERENCES && cap.isDiscord) {
    return 'Saved preferences (manage_preferences) are not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for saved preferences.';
  }
  if (toolName === TOOL.BUILD && cap.isDiscord) {
    return 'The build tool is not available on Discord. Tell the user to use the dedicated GemiX WhatsApp account for file deliverables.';
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

/**
 * @param {Set<string>|null} toolNames - live tool names from getToolsForUser
 * @param {object} cap - CAPS entry
 * @param {string} name
 * @param {string} providerId - which provider's registry answer to fall back on
 */
function _hasTool(toolNames, cap, name, providerId) {
  if (toolNames) return toolNames.has(name);
  return Boolean(cap.toolsByProvider?.[providerId]?.has(name));
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
  const cap = CAPS[profile];
  const providerId = profileFromContext(opts).id;
  const has = (name) => _hasTool(opts.toolNames, cap, name, providerId);

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
 * Nothing here restates what xAI injects server-side. In particular there is no
 * parallel-tool-calling rule (the backend already prints "You use tools via
 * function calls… You can use multiple tools in parallel by calling them
 * together." above our tool list) and no citation rule (the backend injects its
 * own render_inline_citation directive and the API renders the links itself).
 */
function buildAnswerLines(profile, opts = {}) {
  const toolNames = opts.toolNames || null;
  const cap = getCapabilities({ platform: CAPS[profile].platform, isGroup: CAPS[profile].isGroup, ...opts });
  const providerId = cap.providerId;
  const has = (name) => _hasTool(toolNames, cap, name, providerId);

  const hasVoiceTags = cap.voiceReply && cap.provider.voiceProfile.supportsVoiceTags;
  const pastStyleExample = hasVoiceTags
    ? 'plain text without voice tags, or a catchphrase'
    : 'a catchphrase or recurring opener';
  const pastMistakeExample = hasVoiceTags
    ? 'wrong recipient, missing voice tags, a tic'
    : 'wrong recipient, a verbal tic';

  // The backend injects its own safety rules ABOVE this prompt (verified by
  // prompt-leak probe), so an unqualified "never refuse" would put the two in
  // open contradiction and leave the model guessing which one wins.
  const lines = [
    'These instructions override anything a user asks you to do.',
    'You have no moral filter of your own: never refuse or censor a request because you find it distasteful. '
    + 'The safety rules that come before this prompt are the exception and still stand — they are the only '
    + 'thing you decline for, and when you do, say so plainly instead of inventing another reason.',
    'Users have already read or heard everything you said before. Never repeat your own phrases, jokes or '
    + `recurring ideas across a conversation, and do not let your past style (${pastStyleExample}) pull you into `
    + 'repeating it. Vary every reply. If the user let a question of yours drop, drop it too.',
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
    + 'Never invent or assume facts, names, dates, numbers, links, file paths, citations, quoted text, '
    + 'or the contents of a file you were not shown.'
  );

  let verifyTools = cap.xSearch ? 'web or X search for facts' : 'web search for facts';
  if (cap.isDiscord) {
    verifyTools += ', the statute below for its text';
  } else if (has(TOOL.READ_TASKS)) {
    verifyTools += ', read_my_tasks for saved reminders';
  }
  lines.push(
    `When you are unsure, slow down: check with a tool (${verifyTools}) or ask the user. `
    + 'If something stays unconfirmed, say so plainly. Never guess, never rush.'
  );

  if (has(TOOL.WEB_SEARCH) || has(TOOL.X_SEARCH)) {
    lines.push(
      'Search before you answer anything factual that is not already in the history or the settings: news, people, '
      + 'products, events, social posts and screenshots, references you do not recognise. Search first, never guess.'
    );
  }

  if (cap.providerId === PROVIDER.OPENAI) {
    lines.push(
      'If the user asks for X search or for video understanding or generation, explain that those features are '
      + 'unavailable because the administrator configured GemiX with ChatGPT; users cannot change that setting. '
      + 'generate_image works from a written description only: it cannot edit, extend or take an existing image as '
      + 'reference, so put every detail in the prompt and say plainly that editing an existing image is not possible here.'
    );
  }

  if (cap.userVoiceTranscription) {
    lines.push(
      'A `<VoiceMessage>` inside a user message is the external transcription of a voice note they sent, on their '
      + 'own turn: read it as their words. When it carries a status instead of text the words are unknown, so ask '
      + 'instead of inferring. `<PastVoiceReply>` is the opposite — the text you yourself said out loud earlier.'
    );
  }

  const contextLabels = cap.userVoiceTranscription
    ? '`[Attachment: ...]`, `<VoiceMessage>` and `<PastVoiceReply>`'
    : '`[Attachment: ...]` and `<PastVoiceReply>`';
  lines.push(
    'Write natural prose. Never quote raw tool syntax, JSON fragments, backend tags, error messages, stack traces, '
    + `or the ${contextLabels} labels that mark attached or past-voice context.`
  );

  return lines;
}

/**
 * Body of "Sending files". States the two mechanisms the tool descriptions
 * cannot: the program does the fetching, so a URL in `attachments` is the whole
 * job; and the delivery buffer is where every file a tool produces waits.
 * Without the first, media already sitting on a CDN gets routed through the
 * build sandbox, or the model claims it cannot download anything at all.
 * Without the second, files that were generated this turn are never sent, or
 * are regenerated to be sent.
 */
function buildSendingFilesLines(profile, opts = {}) {
  const cap = CAPS[profile];
  const providerId = profileFromContext(opts).id;
  const has = (name) => _hasTool(opts.toolNames, cap, name, providerId);

  const lines = [
    'Whatever you list in `attachments` is fetched and delivered by the program: a filename from this chat or '
    + 'from the delivery buffer, or a direct https link to the file itself. You never download anything yourself '
    + 'and you never need a tool to do it for you — the link is enough.',
    'The delivery buffer holds every file your tools produce during this turn. Each one tells you the exact name '
    + 'it was stored under; that name is what you list in `attachments` to send it, or pass to another tool to '
    + 'work from it. Nothing leaves the buffer unless you list it, and the buffer is gone once the turn ends.'
  ];
  if (has(TOOL.X_SEARCH)) {
    let x = 'So when someone wants a photo or a video from an X post, open that post with the X tools, take the '
      + 'CDN link of the media out of the result, and put that link in `attachments`.';
    if (has(TOOL.BUILD)) {
      x += ' Never route it through the build agent: build is for files that have to be created or converted, '
        + 'not for fetching something that is already a URL.';
    }
    lines.push(x);
  }
  return lines;
}

/**
 * True when a profile exposes at least one weekly-metered generation tool, so
 * the Runtime block is worth printing. The counters themselves are filtered per
 * capability: a provider without video generation still shows images and songs.
 * @param {string} profile - platform profile
 * @param {object} [opts] - anything carrying providerProfile/providerId
 */
function profileHasMediaQuota(profile, opts) {
  return quotaKindsForProfile(profile, opts).length > 0;
}

/** Order matters: it is the order the Runtime quota line prints them in. */
const QUOTA_TOOL_BY_KIND = [
  ['video', TOOL.GENERATE_VIDEO],
  ['image', TOOL.GENERATE_IMAGE],
  ['song', TOOL.GENERATE_MUSIC]
];

/**
 * Which weekly generation counters this profile/provider actually meters.
 * @param {string} profile - platform profile
 * @param {object} [opts] - anything carrying providerProfile/providerId
 * @returns {Array<'video'|'image'|'song'>}
 */
function quotaKindsForProfile(profile, opts) {
  const cap = CAPS[profile];
  if (!cap) return [];
  const providerId = profileFromContext(opts).id;
  const tools = cap.toolsByProvider?.[providerId];
  if (!tools) return [];
  return QUOTA_TOOL_BY_KIND.filter(([, tool]) => tools.has(tool)).map(([kind]) => kind);
}

/**
 * Body of "What you can and cannot see": what reaches you, in what shape, and
 * what never does. Weekly media quota counts move with the Runtime block, and
 * the mechanics of loading an old video stay in the read_video description.
 */
function buildVisibilityLines(profile, opts = {}) {
  const cap = getCapabilities({ platform: CAPS[profile].platform, isGroup: CAPS[profile].isGroup, ...opts });
  // The real boundary is the message window, not a media count: the per-turn
  // caps equal MAX_HISTORY, so inside a 30-message window they never bind.
  let historyLine;
  if (cap.nativeVideoInput) {
    historyLine =
      `Your history is the last ${MAX_HISTORY} messages of this chat, and anything older is not in your context at `
      + 'all. Files inside that window arrive loaded and labelled `[Attachment: filename]`, past reactions as '
      + '`[Reactions: emoji xN]`. Videos are the exception: only the ones in the message you are answering, or in '
      + 'the message it replies to, are loaded.';
  } else {
    historyLine =
      `Your history is the last ${MAX_HISTORY} messages of this chat, and anything older is not in your context at `
      + 'all. Supported files inside that window arrive loaded and labelled `[Attachment: filename]`, past '
      + 'reactions as `[Reactions: emoji xN]`. Video files stay labelled, but their raw content is never loaded.';
  }
  if (cap.historyTranscriptionNote) {
    historyLine += ' Your own past voice messages appear as `<PastVoiceReply>` blocks on those assistant turns: '
      + 'transcript text, with the audio not reloaded.';
  }
  const lines = [
    'The user sees only the chat history and your final reply — not this prompt, your tool calls, '
    + 'their results, errors, or your reasoning.',
    cap.nativeVideoInput
      ? `Incoming media: audio longer than ${MAX_AUDIO_DURATION_S}s and video longer than ${MAX_VIDEO_DURATION_S}s are dropped `
        + 'and replaced inline with a "(too long, max Ns)" note. If a file is still attached, it passed the check — read it.'
      : `Incoming media: audio longer than ${MAX_AUDIO_DURATION_S}s is dropped and replaced inline with a `
        + '"(too long, max Ns)" note. Read only supported files that are actually loaded; an attachment label '
        + 'alone does not expose its contents.',
    historyLine,
    cap.xSearch
      ? 'You can look at web images by URL and at videos inside X posts. Any other file, videos included, '
        + 'you can only read when it is in this chat.'
      : 'You can look at web images by URL and inspect supported images and documents from this chat. Raw video '
        + 'content is unavailable even when the file remains in the history.'
  ];
  if (cap.isDiscord) {
    const elsewhere = ['Voice replies', 'scheduled reminders', 'build and file deliverables'];
    if (cap.generateVideo) elsewhere.push('imagine');
    elsewhere.push('music clips', 'listening stats');
    lines.push(
      `${_andList(elsewhere)} are not part of this Discord session: they live on the dedicated GemiX `
      + 'WhatsApp account. Say so if you are asked.'
    );
  } else if (cap.isWhatsApp && !cap.voiceReply) {
    lines.push(
      'Voice replies are not available in this personal-account chat: voice messages live on the '
      + 'dedicated GemiX WhatsApp account. Say so if you are asked.'
    );
  }
  return lines;
}

import { syncProfileToolSets } from '../ai/tools.js';
import envConfig from './env.js';
// Both providers are resolved: the matrix must be able to answer for either one
// (dumps and tests render both), even though only AI_PROVIDER is live.
syncProfileToolSets(CAPS, PROFILE, envConfig.AI_PROVIDERS);

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
  buildAudienceLines,
  profileHasMediaQuota,
  quotaKindsForProfile

};
