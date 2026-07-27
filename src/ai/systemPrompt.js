// src/ai/systemPrompt.js — static system prefix + dynamic Runtime trailer.
//
// Live path (handler): byte-stable buildStaticInstructions as the first
// input[] role:system item once per turn, then buildDynamicRuntimeContext as
// the last role:system item each AI call. xAI prefix-cache matches from the
// start of input[]; Time, delivery buffer, workspace listing, quotas, settings,
// caller, and turn-varying platform fields stay in the trailer so multi-round
// tool loops keep a stable prefix. Discord Rules context is process-stable → static.

const { getRomeTime, formatTimestamp } = require('../utils/time');
const { ACTIVE_MEMBERS } = require('../config/members');
const { ADMIN_NAME, GROK_MODEL } = require('../config/env');
const { getModelDisplayName } = require('../utils/footer');
const { defaultSettings, customizedFields } = require('../utils/settingsStore');
const { PLATFORM_WA_PERSONAL, BUILD_WORKSPACE_TTL_MS } = require('../config/constants');

/** Human-readable build workspace TTL (from BUILD_WORKSPACE_TTL_MS). */
const BUILD_WORKSPACE_TTL_LABEL = (() => {
  const hours = BUILD_WORKSPACE_TTL_MS / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`;
  const mins = Math.round(BUILD_WORKSPACE_TTL_MS / (60 * 1000));
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
})();
const { formatParticipantsForPrompt } = require('../utils/waParticipants');
const {
  PROFILE,
  resolveProfile,
  buildDirectives,
  buildPreSendCheck,
  buildLimitsLines,
  buildCallerAccessNote,
  getCapabilities,
  profileHasMediaQuota,
} = require('../config/platformCapabilities');
const { getToolsForUser } = require('./tools');
const { formatQuotaCounts, formatMediaQuotaResetLabel } = require('../utils/mediaUsageLimits');
const { escapeXml } = require('../utils/xmlEscape');

const WA_FORMAT = 'only *bold* _italic_ ~strike~ `code` and > quote (line start) render; other markup does not, and Markdown link citations are not shown.';
/** Monthly reminder to re-confirm customized preferences (see settingsStore). */
const SETTINGS_REVIEW_NOTICE =
  'IMPORTANT: the custom settings above have not changed in over a month. Handle the user\'s request as usual, '
  + 'then add a note at the end of your reply reading their settings back to them - focusing on the custom ones - '
  + 'and ask whether they still fit or they want changes. If they ask for changes, apply them with manage_preferences.';
const SYSTEM_LINE_RULE = '[System] entries in chat history are bot-generated server events, not user messages.';
/** One level = 4 spaces. Section body depth 1; nested XML / Rules lists depth 2. */
const PROMPT_INDENT = '    ';

function _indentLines(text, depth) {
  const pad = PROMPT_INDENT.repeat(depth);
  return text.split('\n').map(l => (l.length ? pad + l : l)).join('\n');
}

function _resolvePromptTools(ctx, isActiveMember, isAdmin) {
  const userCtx = {
    platform: ctx.platform,
    isGroup: ctx.isGroup,
    chatId: ctx.chatId,
  };
  const tools = getToolsForUser(isActiveMember, isAdmin, userCtx);
  const toolNames = new Set();
  let hasCodeInterpreter = false;
  for (const t of tools) {
    if (t && t.type === 'code_interpreter') hasCodeInterpreter = true;
    else if (t?.function?.name) toolNames.add(t.function.name);
    else if (typeof t?.type === 'string' && t.type !== 'function') toolNames.add(t.type);
  }
  return { toolNames, hasCodeInterpreter };
}

/** Stable fingerprint of live tool names for mid-turn static rebuild detection. */
function promptToolsFingerprint(ctx) {
  const isActiveMember = Boolean(ctx.userIdentity?.isActiveMember);
  const isAdmin = Boolean(ctx.userIdentity?.isAdmin);
  const { toolNames, hasCodeInterpreter } = _resolvePromptTools(ctx, isActiveMember, isAdmin);
  const names = [...toolNames].sort();
  return `${names.join(',')}|ci=${hasCodeInterpreter ? 1 : 0}`;
}

function _callerLineInner(ctx, promptOpts) {
  const status = promptOpts.isActiveMember !== false ? 'active member' : 'non-active';
  return `${escapeXml(ctx.userName)} (${status}) — the user who triggered this turn.`;
}

function _buildBatchNote() {
  // Debounced multi-message turns keep distinct role:user units (earlier ones
  // in history, last as content). Each unit keeps its author label.
  return '<BatchNote>This turn includes several recent messages from more than one participant '
    + '(each kept as its own user turn with an author label). '
    + '&lt;Caller&gt; is only the author of the latest message.</BatchNote>';
}

/**
 * Byte-stable static system prefix for the first input[] role:system item.
 * Profile / membership / tools for this conversation — no turn-varying fields.
 */
function buildStaticInstructions(ctx) {
  const isActiveMember = Boolean(ctx.userIdentity?.isActiveMember);
  const isAdmin = Boolean(ctx.userIdentity?.isAdmin);
  const profile = resolveProfile(ctx);
  const cap = getCapabilities(ctx);
  const { toolNames, hasCodeInterpreter } = _resolvePromptTools(ctx, isActiveMember, isAdmin);
  // No delivery.includeTitle here — that is a Runtime trailer note so R* stay fixed.
  const promptOpts = { isActiveMember, toolNames, hasCodeInterpreter };

  const sections = [];
  const contextBlocks = [];

  contextBlocks.push(_block('Identity', [
    `Name: you are ${getModelDisplayName(GROK_MODEL)} inside GemiX - fusion of SuperGrok and Gemini${cap.isDiscord ? ' (Legal Division)' : ''}.`,
    'Character: you have a sense of irony, you understand even when it\'s implied.',
  ]));

  if (profile === PROFILE.DISCORD_THREAD) {
    contextBlocks.push(_buildDiscordPlatformStatic());
    // Statute is process-cached and conversation-stable (~24KB) — keep in
    // static instructions so multi-round tool loops do not re-send it with Time.
    if (ctx.rulesContext) {
      contextBlocks.push(`Rules context: ${escapeXml(ctx.rulesContext)}`);
    }
  } else if (ctx.platform === PLATFORM_WA_PERSONAL) {
    contextBlocks.push(_buildPersonalWaPlatformStatic(ctx, promptOpts));
  } else {
    contextBlocks.push(_buildDedicatedWaPlatformStatic(ctx, cap, promptOpts));
  }

  if (isActiveMember) {
    if (isAdmin) {
      // Admin addresses members directly by phone/email (see send_* and
      // schedule_tasks). The roster gives the exact identifiers so no name
      // lookup is needed and reminders never default to the caller by mistake.
      const roster = ACTIVE_MEMBERS.map((m) => {
        const num = (m.wa || '').split('@')[0].split(':')[0] || '?';
        const email = m.email ? `, ${m.email}` : '';
        return `${escapeXml(m.name)} (${num}${escapeXml(email)})`;
      }).join('; ');
      const deliveryToolHint = profile === PROFILE.DISCORD_THREAD
        ? 'send_whatsapp_message and send_email tools'
        : 'send_whatsapp_message, send_email, and schedule_tasks';
      const deliveryRule = profile === PROFILE.DISCORD_THREAD
        ? 'external destinations only'
        : 'send_whatsapp_message/send_email: external destinations only; schedule_tasks: omit destination for current chat/group, or set recipient for someone else';
      contextBlocks.push(`<ActiveMembers>Address them in ${deliveryToolHint} by the phone/email in this list — ${deliveryRule}. ${roster}.</ActiveMembers>`);
    } else {
      const members = ACTIVE_MEMBERS.map(m => m.name).join(', ');
      contextBlocks.push(`<ActiveMembers>${members}. In delivery tools, address others by roster name.</ActiveMembers>`);
    }
  }

  // Static limits only (no weekly quota counts — those refresh mid tool-loop).
  contextBlocks.push(_block('Limits', buildLimitsLines(profile)));

  // Macro 1: everything GemiX must KNOW (declarative, stable for the turn).
  sections.push(_macro('Context', contextBlocks));

  // Macro 2: everything GemiX must DO (imperative). Numbered R1..Rn with a
  // per-line scope marker; the count feeds the final check below.
  const { block: directivesBlock, count } = _renderDirectives(buildDirectives(profile, promptOpts));
  sections.push(directivesBlock);

  // Macro 3: enforcement, last for maximum recency within static instructions.
  sections.push(_block('PreSendCheck', buildPreSendCheck(count)));

  return sections.join('\n');
}

/**
 * Program-owned turn-varying state. Handler appends this as the last
 * input[] item (role:system, `_runtimeTrailer: true`) before every AI call.
 */
function buildDynamicRuntimeContext(ctx) {
  const now = getRomeTime();
  const isActiveMember = Boolean(ctx.userIdentity?.isActiveMember);
  const isAdmin = Boolean(ctx.userIdentity?.isAdmin);
  const profile = resolveProfile(ctx);
  const cap = getCapabilities(ctx);
  const delivery = ctx.deliveryState || { bufferFiles: [], includeTitle: false };
  const promptOpts = { isActiveMember };

  const blocks = [];

  blocks.push(`Time (Europe/Rome): ${now}.`);
  blocks.push(`<Caller>${_callerLineInner(ctx, promptOpts)}</Caller>`);

  if (ctx.batchMultiSpeaker) {
    blocks.push(_buildBatchNote());
  }

  if (profile === PROFILE.DISCORD_THREAD) {
    if (ctx.threadName && !delivery.includeTitle) {
      blocks.push(`Thread title: ${escapeXml(ctx.threadName)}`);
    }
    if (ctx.availableEmojis) blocks.push(`Emojis: ${ctx.availableEmojis}`);
    if (ctx.serverEvents) blocks.push(`Events: ${ctx.serverEvents}`);
  } else if (ctx.isGroup) {
    const roster = Array.isArray(ctx.groupParticipants) ? ctx.groupParticipants : [];
    if (roster.length > 0) {
      blocks.push(`Participants: ${formatParticipantsForPrompt(roster, escapeXml)}`);
    }
  }

  const bufferFiles = Array.isArray(delivery.bufferFiles) ? delivery.bufferFiles : [];
  if (bufferFiles.length > 0) {
    blocks.push(`<DeliveryBuffer>${escapeXml(bufferFiles.join(', '))}</DeliveryBuffer>`);
  }

  if (cap.buildWorkspace) {
    blocks.push(_renderBuildWorkspace(ctx.userWorkspace));
  }

  // Per-user weekly generation quota line: non-admins only, and only where the
  // three generation tools exist (WhatsApp) — admins and Discord get no line.
  if (!isAdmin && profileHasMediaQuota(profile)) {
    const counts = formatQuotaCounts(ctx.userIdentity?.taskFileId);
    blocks.push(
      `Weekly generation quota for this user — ${counts} `
      + `(resets ${formatMediaQuotaResetLabel()}). At the cap the tool returns an error; `
      + 'if the user asks, tell them what is left.',
    );
  }

  if (cap.longTermMemory) {
    blocks.push(_renderCurrentSettings(ctx));
    if (ctx.settingsReviewDue) {
      blocks.push(_block('SettingsReview', [SETTINGS_REVIEW_NOTICE]));
    }
  }

  if (delivery.includeTitle) {
    blocks.push(
      'First message of this thread: `conversation_title` is required '
      + '(short topic title, user\'s language, no emoji).',
    );
  }

  return _macro('Runtime', blocks);
}

/**
 * Render the per-chat preferences GemiX must honour, each flagged as (default)
 * or (custom) so it can tell at a glance what the user actually chose.
 */
function _renderCurrentSettings(ctx) {
  const settings = ctx.settings || { ...defaultSettings(), updatedAt: null };
  const custom = new Set(customizedFields(settings));
  const scope = ctx.isGroup
    ? 'group'
    : (ctx.platform === PLATFORM_WA_PERSONAL ? 'chat' : 'user');
  const mark = (field) => (custom.has(field) ? 'custom' : 'default');
  const lines = [
    `Voice: ${settings.voice} (${mark('voice')})`,
    `Effort: ${settings.effort} (${mark('effort')})`,
    `Language: ${settings.language} (${mark('language')})`,
    `Memory: ${escapeXml(settings.memory)} (${mark('memory')})`,
    `Last update: ${settings.updatedAt ? formatTimestamp(settings.updatedAt) : 'never (all defaults)'}`,
  ];
  const body = _indentLines(lines.join('\n'), 1);
  return `<CurrentSettings scope="${scope}">\n${body}\n</CurrentSettings>`;
}

/** Persisted build sub-agent workspace listing (WhatsApp only). Always emitted. */
function _renderBuildWorkspace(ws) {
  const total = ws?.total ?? 0;
  if (total > 0) {
    const items = ws.files.map(f => `    - ${f.relPath}`).join('\n');
    const more = ws.more ? '\n    ... and more' : '';
    return (
      `<BuildWorkspace files="${total}">\n${items}${more}\n`
      + `    On disk only (${BUILD_WORKSPACE_TTL_LABEL} TTL) until build runs — then new/modified workspace files are harvested into the delivery buffer; pick final user \`attachments\` from that buffer.\n`
      + '    To re-send existing outputs: ask build with a resend-only prompt and attachments=[].\n'
      + '</BuildWorkspace>'
    );
  }
  return (
    '<BuildWorkspace files="0">\n'
    + '    (empty — authoritative; do not call build to search for missing files)\n'
    + `    If the user asks for a past build output, explain it expired (${BUILD_WORKSPACE_TTL_LABEL} TTL).\n`
    + '</BuildWorkspace>'
  );
}

function _platformField(label, content) {
  return `${PROMPT_INDENT}${label}: ${content}`;
}

/** Discord structural Platform only (thread title / emojis / events are Runtime). */
function _buildDiscordPlatformStatic() {
  const lines = [
    '<Platform name="discord">',
    _platformField('Role', 'Help with Statute (Statuto Albertino) rules and generate Art. 6 formal PDF requests. Active in the "gemix" channel.'),
    _platformField('Format', 'Markdown supported (but no tables).'),
    '</Platform>',
  ];
  return lines.join('\n');
}

/** Personal WA structural Platform (Caller is in Runtime). */
function _buildPersonalWaPlatformStatic(ctx, promptOpts) {
  const otherName = ctx.personalOtherUserName
    ? escapeXml(ctx.personalOtherUserName)
    : 'the other participant';
  const lines = [
    '<Platform name="whatsapp_personal">',
    _platformField('Rule', 'Admin-account chat with one other user. Reply only when this message contains @gemix. History, memory, and build workspace are shared for this chat pair.'),
    _platformField('Chat', `You (GemiX, never tag yourself), ${escapeXml(ADMIN_NAME)} (Account Owner), ${otherName}`),
    _platformField('History notes', 'Admin messages appear in history under the label "Account Owner", not their name. Your replies have no speaker prefix.'),
    _platformField('Format', WA_FORMAT),
  ];
  const access = buildCallerAccessNote(PROFILE.WA_PERSONAL, promptOpts);
  if (access) lines.push(_platformField('Caller access', access));
  lines.push('</Platform>');
  return lines.join('\n');
}

/** Dedicated WA structural Platform (Caller / Participants are in Runtime). */
function _buildDedicatedWaPlatformStatic(ctx, cap, promptOpts) {
  const lines = ['<Platform name="whatsapp_dedicated">'];
  if (ctx.isGroup) {
    lines.push(_platformField('Group name', escapeXml(ctx.groupName) || 'unknown'));
    lines.push(_platformField('Rule', 'Reply when @mentioned or when the user replies to a GemiX message.'));
    lines.push(_platformField('Mentions', 'REQUIRED when you name another member (anyone except <Caller>) in the reply: @<phone digits> only (no +, no display name after @).'));
  } else {
    lines.push(_platformField('Rule', 'Private chat - reply to every message.'));
    lines.push(_platformField('Chat', `You (GemiX, never tag yourself) and ${escapeXml(ctx.userName)}.`));
  }
  if (cap.systemHistoryLabel) {
    lines.push(_platformField('History notes', SYSTEM_LINE_RULE));
  }
  lines.push(_platformField('Format', WA_FORMAT));
  const access = buildCallerAccessNote(resolveProfile(ctx), promptOpts);
  if (access) lines.push(_platformField('Caller access', access));
  lines.push('</Platform>');
  return lines.join('\n');
}

function _block(tag, lines) {
  const body = _indentLines(lines.join('\n'), 1);
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** Wrap already-rendered blocks under a macro tag, indenting each one level. */
function _macro(tag, blocks) {
  const body = blocks.map(b => _indentLines(b, 1)).join('\n');
  return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * Render the <Directives> macro from grouped entries. Numbers run globally
 * (R1..Rn) across every sub-tag so <PreSendCheck> can reference the full set;
 * returns the rendered block plus the final count.
 */
function _renderDirectives(groups) {
  let n = 0;
  const parts = [];
  for (const g of groups) {
    if (!g.lines || g.lines.length === 0) continue;
    const body = g.lines.map((l) => {
      n += 1;
      return `        R${n} [${l.scope}] ${l.text}`;
    }).join('\n');
    parts.push(`    <${g.tag}>\n${body}\n    </${g.tag}>`);
  }
  return { block: `<Directives>\n${parts.join('\n')}\n</Directives>`, count: n };
}

module.exports = {
  buildStaticInstructions,
  buildDynamicRuntimeContext,
  promptToolsFingerprint,
};
