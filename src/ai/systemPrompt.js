// src/ai/systemPrompt.js — composed system prompt from platformCapabilities + ctx.

const { getRomeTime } = require('../utils/time');
const { ACTIVE_MEMBERS } = require('../config/members');
const { ADMIN_NAME } = require('../config/env');
const { PLATFORM_WA_PERSONAL } = require('../config/constants');
const { formatParticipantsForPrompt } = require('../utils/waParticipants');
const {
  PROFILE,
  resolveProfile,
  buildDirectives,
  buildPreSendCheck,
  buildLimitsLines,
  buildCallerAccessNote,
  getCapabilities,
} = require('../config/platformCapabilities');
const { getToolsForUser } = require('./tools');
const { escapeXml } = require('../utils/xmlEscape');

const WA_FORMAT = 'only *bold* _italic_ ~strike~ `code` and > quote (line start) render; other markup does not, and Markdown link citations are not shown.';
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

function _callerLineInner(ctx, promptOpts) {
  const status = promptOpts.isActiveMember !== false ? 'active member' : 'non-active';
  return `${escapeXml(ctx.userName)} (${status}) — the user who triggered this turn.`;
}

function _buildBatchNote(profile) {
  void profile;
  // Debounced multi-message turns keep distinct role:user units (earlier ones
  // in history, last as content). Each unit keeps its author label.
  return '<BatchNote>This turn includes several recent messages from more than one participant '
    + '(each kept as its own user turn with an author label). '
    + '&lt;Caller&gt; is only the author of the latest message.</BatchNote>';
}

function buildSystemPrompt(ctx) {
  const now = getRomeTime();
  const isActiveMember = Boolean(ctx.userIdentity?.isActiveMember);
  const isAdmin = Boolean(ctx.userIdentity?.isAdmin);
  const profile = resolveProfile(ctx);
  const cap = getCapabilities(ctx);
  const { toolNames, hasCodeInterpreter } = _resolvePromptTools(ctx, isActiveMember, isAdmin);
  // Delivery / structured-reply state for this round (set by handler.js).
  // Outside the handler (e.g. prompt audit script) it defaults to empty.
  const delivery = ctx.deliveryState || { bufferFiles: [], includeTitle: false };
  const promptOpts = { isActiveMember, toolNames, hasCodeInterpreter, delivery };

  const sections = [];
  const contextBlocks = [];

  contextBlocks.push(_block('Identity', [
    `Name: GemiX - fusion of SuperGrok and Gemini${cap.isDiscord ? ' (Legal Division)' : ''}.`,
    `Time (Europe/Rome): ${now}.`,
    'Persona: you have a sense of irony, you understand even when it\'s implied.',
  ]));

  if (profile === PROFILE.DISCORD_THREAD) contextBlocks.push(_buildDiscordPlatform(ctx, promptOpts));
  else if (ctx.platform === PLATFORM_WA_PERSONAL) contextBlocks.push(_buildPersonalWaPlatform(ctx, promptOpts));
  else contextBlocks.push(_buildDedicatedWaPlatform(ctx, cap, promptOpts));
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
  if (ctx.batchMultiSpeaker) {
    contextBlocks.push(_buildBatchNote(profile));
  }

  const bufferFiles = Array.isArray(delivery.bufferFiles) ? delivery.bufferFiles : [];
  if (bufferFiles.length > 0) {
    contextBlocks.push(`<DeliveryBuffer>${escapeXml(bufferFiles.join(', '))}</DeliveryBuffer>`);
  }

  if (cap.buildWorkspace) {
    contextBlocks.push(_renderBuildWorkspace(ctx.userWorkspace));
  }

  contextBlocks.push(_block('Limits', buildLimitsLines(profile)));

  if (cap.longTermMemory) {
    let defaultMemory = 'Default guidelines: reply in Italian; use emojis sparingly.';
    if (cap.voiceReply) {
      defaultMemory += ' Use voice replies (voice:true) for short, casual, non-technical messages; use text for long or technical ones. Vary voice vs text across your recent replies so you are not repetitive.';
    }
    const sharedMemory = ctx.isGroup || ctx.platform === PLATFORM_WA_PERSONAL;
    if (sharedMemory) {
      const label = ctx.platform === PLATFORM_WA_PERSONAL ? 'Chat' : 'Group';
      const body = escapeXml(ctx.groupMemory || defaultMemory);
      contextBlocks.push(`<Memory>\n    <${label}>${body}</${label}>\n</Memory>`);
    } else {
      const body = escapeXml(ctx.userMemory || defaultMemory);
      contextBlocks.push(`<Memory>\n    <User>${body}</User>\n</Memory>`);
    }
  }

  // Macro 1: everything GemiX must KNOW (declarative).
  sections.push(_macro('Context', contextBlocks));

  // Macro 2: everything GemiX must DO (imperative). Numbered R1..Rn with a
  // per-line scope marker; the count feeds the final check below.
  const { block: directivesBlock, count } = _renderDirectives(buildDirectives(profile, promptOpts));
  sections.push(directivesBlock);

  // Macro 3: enforcement, last for maximum recency.
  sections.push(_block('PreSendCheck', buildPreSendCheck(count)));

  return sections.join('\n');
}

/** Persisted build sub-agent workspace listing (WhatsApp only). Always emitted. */
function _renderBuildWorkspace(ws) {
  const total = ws?.total ?? 0;
  if (total > 0) {
    const items = ws.files.map(f => `    - ${f.relPath}`).join('\n');
    const more = ws.more ? '\n    ... and more' : '';
    return (
      `<BuildWorkspace files="${total}">\n${items}${more}\n`
      + '    On disk only (4h TTL) until build runs — then new/modified workspace files are harvested into the delivery buffer; pick final user `attachments` from that buffer.\n'
      + '    To re-send existing outputs: ask build with a resend-only prompt and attachments=[].\n'
      + '</BuildWorkspace>'
    );
  }
  return (
    '<BuildWorkspace files="0">\n'
    + '    (empty — authoritative; do not call build to search for missing files)\n'
    + '    If the user asks for a past build output, explain it expired (4h TTL).\n'
    + '</BuildWorkspace>'
  );
}

function _platformField(label, content) {
  return `${PROMPT_INDENT}${label}: ${content}`;
}

function _buildDiscordPlatform(ctx, promptOpts) {
  const lines = ['<Platform name="discord">'];
  lines.push(_platformField('Role', 'Help with Statute (Statuto Albertino) rules and generate Art. 6 formal PDF requests. Active in the "gemix" channel.'));
  if (ctx.threadName && !ctx.deliveryState?.includeTitle) {
    lines.push(_platformField('Thread title', escapeXml(ctx.threadName)));
  }
  lines.push(_platformField('Format', 'Markdown supported (but no tables).'));
  if (ctx.availableEmojis) lines.push(_platformField('Emojis', ctx.availableEmojis));
  if (ctx.serverEvents) lines.push(_platformField('Events', ctx.serverEvents));
  if (ctx.rulesContext) lines.push(_platformField('Rules context', escapeXml(ctx.rulesContext)));
  lines.push(_platformField('Caller', _callerLineInner(ctx, promptOpts)));
  lines.push('</Platform>');
  return lines.join('\n');
}

function _buildPersonalWaPlatform(ctx, promptOpts) {
  const otherName = ctx.personalOtherUserName
    ? escapeXml(ctx.personalOtherUserName)
    : 'the other participant';
  const lines = [
    '<Platform name="whatsapp_personal">',
    _platformField('Rule', 'Admin-account chat with one other user. Reply only when this message contains @gemix. History, memory, and build workspace are shared for this chat pair.'),
    _platformField('Chat', `You (GemiX, never tag yourself), ${escapeXml(ADMIN_NAME)} (Account Owner), ${otherName}`),
    _platformField('History notes', 'Admin messages appear in history under the label "Account Owner", not their name. Your replies have no speaker prefix.'),
    _platformField('Caller', _callerLineInner(ctx, promptOpts)),
    _platformField('Format', WA_FORMAT),
  ];
  const access = buildCallerAccessNote(PROFILE.WA_PERSONAL, promptOpts);
  if (access) lines.push(_platformField('Caller access', access));
  lines.push('</Platform>');
  return lines.join('\n');
}

function _buildDedicatedWaPlatform(ctx, cap, promptOpts) {
  const lines = ['<Platform name="whatsapp_dedicated">'];
  if (ctx.isGroup) {
    lines.push(_platformField('Group name', escapeXml(ctx.groupName) || 'unknown'));
    lines.push(_platformField('Rule', 'Reply when @mentioned or when the user replies to a GemiX message.'));
    const roster = Array.isArray(ctx.groupParticipants) ? ctx.groupParticipants : [];
    if (roster.length > 0) {
      lines.push(_platformField('Participants', formatParticipantsForPrompt(roster, escapeXml)));
    }
    lines.push(_platformField('Mentions', 'REQUIRED when you name another member (anyone except <Caller>) in the reply: @<phone digits> only (no +, no display name after @).'));
  } else {
    lines.push(_platformField('Rule', 'Private chat - reply to every message.'));
    lines.push(_platformField('Chat', `You (GemiX, never tag yourself) and ${escapeXml(ctx.userName)}.`));
  }
  if (cap.systemHistoryLabel) {
    lines.push(_platformField('History notes', SYSTEM_LINE_RULE));
  }
  lines.push(_platformField('Caller', _callerLineInner(ctx, promptOpts)));
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

function _blockRaw(tag, blocks) {
  const body = blocks.map(b => _indentLines(b, 1)).join('\n');
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

module.exports = { buildSystemPrompt };