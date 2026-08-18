// scripts/prompt-dumps/validate.js
//
// Every assertion made about a rendered dump. Each check pushes to a shared
// ISSUES list; the orchestrator exits non-zero when it is non-empty.
//
// Case selection is always derived from the case ctx itself (platform,
// membership, userWorkspace, settings…) rather than hard-coded id lists, so
// adding or renumbering a case in cases.js never silently skips a check.

import constants from '../../src/config/constants.js';
import { PRIVACY_WIPE_COMMAND } from '../../src/config/systemMessages.js';
import { getCapabilities, quotaKindsForProfile, resolveProfile } from '../../src/config/platformCapabilities.js';
import { getProviderProfile, PROVIDER } from '../../src/ai/providers/providerProfile.js';
import { formatQuotaCounts } from '../../src/utils/mediaUsageLimits.js';
import { getToolsForUser } from '../../src/ai/tools.js';
import { CASES } from './cases.js';

const { PLATFORM_DISCORD } = constants;

const ISSUES = [];

// -- Case groupings, all derived from CASES --------------------------------

const caseIds = Object.keys(CASES).map(Number);
/** The case ctx as it renders under one provider. */
const _ctx = (id, providerId) => ({ ...CASES[id].ctx, providerProfile: getProviderProfile(providerId) });
const _is = (pred) => caseIds.filter(i => pred(CASES[i].ctx));

const DISCORD_CASES = _is(c => c.platform === PLATFORM_DISCORD);
const WHATSAPP_CASES = _is(c => c.platform !== PLATFORM_DISCORD);
const NON_ACTIVE_CASES = _is(c => c.userIdentity?.isActiveMember === false);
const NON_ADMIN_ACTIVE_CASES = _is(c => c.userIdentity?.isActiveMember !== false && !c.userIdentity?.isAdmin);
const CUSTOM_SETTINGS_CASES = _is(c => c.settings !== undefined);
const REVIEW_DUE_CASES = _is(c => c.settingsReviewDue === true);
const WORKSPACE_CASES = _is(c => Boolean(c.userWorkspace));

// Voice and quota depend on the provider as well as the platform, so they are
// resolved per profile instead of once at module load.
const _perProvider = new Map();
function _groups(providerId) {
  const cached = _perProvider.get(providerId);
  if (cached) return cached;
  const voice = caseIds.filter(i => getCapabilities(_ctx(i, providerId)).voiceReply);
  // Weekly quota: non-admin callers on a platform that meters generation tools.
  const quota = WHATSAPP_CASES.filter(i => !CASES[i].ctx.userIdentity?.isAdmin);
  const groups = { voice, quota };
  _perProvider.set(providerId, groups);
  return groups;
}
// -- Implementation-leak sweep ---------------------------------------------

/** Agent-facing prompts/tool text must not leak backend wiring. */
const IMPL_LEAK_PATTERNS = [
  { re: /input_file/i, label: 'input_file' },
  { re: /input_image/i, label: 'input_image' },
  { re: /numbered lines/i, label: 'numbered lines' },
  { re: /server-side via public/i, label: 'server-side via public' },
  { re: /display-only/i, label: 'display-only' },
  { re: /raw file bytes/i, label: 'raw file bytes' },
  { re: /tmpfile\.link/i, label: 'tmpfile.link' },
  { re: /attached server-side/i, label: 'attached server-side' },
  { re: /returns inline in the tool result/i, label: 'returns inline in the tool result' },
  { re: /injected into the current turn/i, label: 'injected into the current turn' },
  { re: /Added to the current turn/i, label: 'Added to the current turn' }
];

function validateNoImplLeaks(text, caseId, scope) {
  for (const { re, label } of IMPL_LEAK_PATTERNS) {
    if (re.test(text)) {
      ISSUES.push({ caseId, msg: `${scope} leaks implementation detail: ${label}` });
    }
  }
}

function validateToolDumpLeaks(dump, caseId) {
  const toolsStart = dump.indexOf('--- TOOLS');
  if (toolsStart < 0) return;
  validateNoImplLeaks(dump.slice(toolsStart), caseId, 'tool schema');
}

// -- Provider isolation ----------------------------------------------------

/**
 * Words that belong to exactly one profile.
 *
 * A dump that mentions the other provider's brand, tools or endpoints is a real
 * defect: the model would be told about something it does not have, or told it
 * is something it is not. The lists cover the indirect references too — a voice
 * tag, an inline-citation directive or an "X post" aside leaks just as much as
 * the brand name.
 */
const PROVIDER_DENY = {
  [PROVIDER.XAI]: [
    { re: /ChatGPT/i, label: 'ChatGPT' },
    { re: /\bGPT-\d/i, label: 'a GPT model slug' },
    { re: /Codex/i, label: 'Codex' },
    { re: /Google Translate/i, label: 'Google Translate TTS' },
    { re: /<VoiceMessage/i, label: '<VoiceMessage>' },
    { re: /gpt-image/i, label: 'gpt-image' }
  ],
  [PROVIDER.OPENAI]: [
    { re: /\bGrok\b/i, label: 'Grok' },
    { re: /\bxAI\b/i, label: 'xAI' },
    { re: /SuperGrok/i, label: 'SuperGrok' },
    { re: /Imagine/i, label: 'Grok Imagine' },
    { re: /render_inline_citation/i, label: 'render_inline_citation' },
    { re: /web or X search/i, label: '"web or X search"' },
    { re: /Not for X\/Twitter/i, label: '"Not for X/Twitter"' },
    { re: /𝕏/, label: 'the X glyph' },
    { re: /X post|X\/Twitter/i, label: 'an X post reference' },
    { re: /\[pause\]|voice tags/i, label: 'xAI voice tags' }
  ]
};

/** Tools that must not appear anywhere GemiX writes on that profile. */
const MISSING_TOOL_NAMES = {
  [PROVIDER.XAI]: [],
  [PROVIDER.OPENAI]: ['x_search', 'read_video', 'generate_video']
};

/** Text every profile must state about itself. */
function _identityRequirement(providerId) {
  const profile = getProviderProfile(providerId);
  return [
    { re: new RegExp(`^You are ${profile.displayName} inside GemiX`, 'm'), label: `the "${profile.displayName}" identity opening` },
    { re: /grew into SuperGrok and kept the name/, label: 'the shared GemiX origin sentence' }
  ];
}

/**
 * Assert one rendered dump belongs to its profile and to no other.
 * @param {string} text - the whole dump
 * @param {number|string} caseId
 * @param {string} providerId
 */
function validateProviderIsolation(text, caseId, providerId) {
  const scope = `${providerId}/${caseId}`;
  // The opening states GemiX's shared origin — Gemini and Grok tools that grew
  // into SuperGrok — on every profile by design. It is the only sanctioned
  // cross-brand mention, so the sweep runs on everything except that line.
  const body = text.replace(/^You are .*$/m, '');
  for (const { re, label } of PROVIDER_DENY[providerId] || []) {
    if (re.test(body)) {
      ISSUES.push({ caseId: scope, msg: `dump mentions ${label}, which does not exist on this profile` });
    }
  }
  // Tools the profile does not have may still be named in the "[not in this
  // context]" errors — that text exists precisely to answer a call for one — but
  // never in what GemiX sends unprompted.
  const sent = text.split('--- TOOL ERRORS')[0];
  for (const name of MISSING_TOOL_NAMES[providerId] || []) {
    if (sent.includes(name)) {
      ISSUES.push({ caseId: scope, msg: `"${name}" is offered or described on a profile that does not have it` });
    }
  }

  // The build dump has no system prompt, so only the case dumps carry identity.
  if (caseId === 'build') return;
  for (const { re, label } of _identityRequirement(providerId)) {
    if (!re.test(text)) {
      ISSUES.push({ caseId: scope, msg: `dump is missing ${label}` });
    }
  }
}

// -- Structured output -----------------------------------------------------

function validateResponseFormat(dump, caseId, providerId) {
  const fmtStart = dump.indexOf('--- STRUCTURED OUTPUT');
  if (fmtStart < 0) return;
  const fmtEnd = dump.indexOf('\n--- TOOL ERRORS', fmtStart);
  const fmt = fmtEnd >= 0 ? dump.slice(fmtStart, fmtEnd) : dump.slice(fmtStart);
  const hasVoice = /voice \(boolean, required\)/.test(fmt);
  const hasVoiceTagDesc = /voice tags below|\[pause\]/.test(fmt);
  const hasTitle = /conversation_title \(string, required\)/.test(fmt);
  const id = Number(caseId);
  const wantsVoiceTags = getProviderProfile(providerId).voiceProfile.supportsVoiceTags;

  if (_groups(providerId).voice.includes(id)) {
    if (!hasVoice) ISSUES.push({ caseId, msg: 'voice case missing the voice schema field' });
    if (wantsVoiceTags && !hasVoiceTagDesc) {
      ISSUES.push({ caseId, msg: 'voice case missing voice tag instructions in the response schema' });
    }
    if (!wantsVoiceTags) {
      if (hasVoiceTagDesc) {
        ISSUES.push({ caseId, msg: 'this voice backend has no tags — the schema must not describe them' });
      }
      if (!/Google Translate/.test(fmt)) {
        ISSUES.push({ caseId, msg: 'voice schema must name the Google Translate backend on this profile' });
      }
    }
  } else {
    if (hasVoice) ISSUES.push({ caseId, msg: 'non-voice case must not expose voice schema field' });
    if (hasVoiceTagDesc) ISSUES.push({ caseId, msg: 'non-voice case must not expose voice tag instructions in response schema' });
  }
  // conversation_title is required in text.format on every Discord turn.
  if (DISCORD_CASES.includes(id)) {
    if (!hasTitle) ISSUES.push({ caseId, msg: 'Discord text.format must require conversation_title' });
  } else if (hasTitle) {
    ISSUES.push({ caseId, msg: 'non-Discord case must not expose conversation_title schema field' });
  }
}

// -- Prompt ----------------------------------------------------------------

/**
 * Body of one "## Heading" section of the static prefix, up to the next heading.
 * @returns {string|null} null when the section is absent
 */
function _promptSection(staticPart, heading) {
  const start = staticPart.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const from = start + heading.length + 5;
  const next = staticPart.indexOf('\n## ', from);
  return next < 0 ? staticPart.slice(from) : staticPart.slice(from, next);
}

/** Prose shape, section order and the blocks retired by the prose rewrite. */
function _validateStaticShape(staticPart, prompt, caseId, providerId) {
  // Prose sections, in order. XML is reserved for program data.
  const headings = [...staticPart.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  const required = [
    'This chat',
    'Who you are talking to',
    'Program-owned turns',
    'What you can and cannot see',
    'How you answer'
  ];
  for (const name of required) {
    if (!headings.includes(name)) {
      ISSUES.push({ caseId, msg: `static missing "## ${name}" section` });
    }
  }
  const order = required.map(n => headings.indexOf(n)).filter(i => i >= 0);
  if (order.some((v, i) => i > 0 && v < order[i - 1])) {
    ISSUES.push({ caseId, msg: `static sections out of order (${headings.join(' → ')})` });
  }
  // The opening carries the model name and the standing goal.
  const opening = staticPart.split('\n## ')[0];
  const expectedModel = getProviderProfile(providerId).displayName;
  if (!opening.includes(expectedModel)) {
    ISSUES.push({ caseId, msg: `opening missing model display name "${expectedModel}"` });
  }
  if (!opening.includes('<user_query>')) {
    ISSUES.push({ caseId, msg: 'opening must point at the <user_query> tag as the goal' });
  }
  // Only program data may open a line with a tag; instructions are prose.
  for (const line of staticPart.split('\n')) {
    if (!line.startsWith('<')) continue;
    if (/^<(ActiveMembers|Statute)>/.test(line)) continue;
    ISSUES.push({ caseId, msg: `static instruction rendered as XML: ${line.slice(0, 48)}` });
    break;
  }
  // Scaffolding retired in the phase-B rewrite.
  for (const gone of ['<Context>', '<Directives>', '<PreSendCheck>', '<Platform', '<Limits>', '<Identity>', '<Conduct>', '<Style>', '<Grounding>', '<Tooling>', 'Rules context:']) {
    if (staticPart.includes(gone)) {
      ISSUES.push({ caseId, msg: `static still contains retired block ${gone}` });
    }
  }
  if (/R\d+ \[(always|out|reply|tool)\]/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static still numbers directives R<n> [scope]' });
  }
  // Legacy top-level blocks, all folded into prose sections.
  for (const gone of ['<Rules>', '<ToolUsage>', '<Capabilities>', '<Conversation>', '<Memory>', '<Reactions>', '<Visibility>']) {
    if (prompt.includes(gone)) {
      ISSUES.push({ caseId, msg: `obsolete ${gone} block must be removed` });
    }
  }
  if (/\s+\n<\/[A-Za-z]+>/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'trailing whitespace before a closing tag' });
  }
}

/** Claims the prompt must no longer make, on either side of the split. */
function _validateNoStaleClaims(staticPart, prompt, caseId) {
  // xAI injects its own citation directive and the API renders [[N]](url) itself.
  if (/Cite web sources with links/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'static must not duplicate the xAI citation directive' });
  }
  if (/system prompt Format line/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'stale cross-reference to the removed "Format line"' });
  }
  if (/read_server_rules/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'read_server_rules no longer exists (removed in A4)' });
  }
  if (prompt.includes('native processing via tunnel')) {
    ISSUES.push({ caseId, msg: 'contains native processing via tunnel' });
  }
  if (/all audio\/video|tutti.*audio\/video/i.test(prompt) && /temp link|link temporaneo/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'obsolete proactive all A/V temp-link policy in prompt' });
  }
  // The buffer is always empty when the Runtime block is built, so it is
  // described in prose and each tool result names its own file instead.
  if (/<DeliveryBuffer>/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'DeliveryBuffer block was retired: tool results name their own files' });
  }
  // conversation_title rules live in text.format only.
  if (/conversation_title/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not mention conversation_title (text.format only)' });
  }
  if (/First message of this thread/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not claim a first-turn-only title rule' });
  }
}

/** Turn-varying material must sit in Runtime, never in the cached static prefix. */
function _validateStaticDynamicSplit(staticPart, dynamicPart, caseId) {
  if (/Time \(Europe\/Rome\)/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include Time (belongs in the Runtime block)' });
  }
  if (!/Time \(Europe\/Rome\)/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'dynamic Runtime missing Time' });
  }
  // Prose may name a Runtime tag (`<CurrentSettings>`); what static must never
  // carry is the block itself, which only ever opens a line.
  for (const tag of ['CurrentSettings', 'BuildWorkspace', 'SettingsReview', 'Caller']) {
    if (new RegExp(`^<${tag}[ >]`, 'm').test(staticPart)) {
      ISSUES.push({ caseId, msg: `static must not include the ${tag} block (belongs in Runtime)` });
    }
  }
  if (/Weekly generation quota for this user/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include media quota line (belongs in Runtime)' });
  }
  // Caller identity is Runtime-only: it changes turn to turn.
  if (!dynamicPart.includes('<Caller>')) {
    ISSUES.push({ caseId, msg: 'Runtime missing <Caller>' });
  }
  if (/^(Caller|Participants):/m.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not name the caller or the roster (belongs in Runtime)' });
  }
}

function _validateBuildWorkspace(dynamicPart, id, caseId) {
  if (!WHATSAPP_CASES.includes(id)) return;
  if (!/<BuildWorkspace files="/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'WhatsApp case missing BuildWorkspace block in Runtime' });
    return;
  }
  if (!WORKSPACE_CASES.includes(id)) {
    if (!/<BuildWorkspace files="0"/.test(dynamicPart)) {
      ISSUES.push({ caseId, msg: 'case without a workspace should show BuildWorkspace files="0"' });
    }
    return;
  }
  if (!/delivery buffer/i.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'BuildWorkspace missing delivery-buffer wording' });
  }
  if (!/resend-only|re-send/i.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'BuildWorkspace missing resend-only build wording' });
  }
  for (const { relPath } of _ctx(id).userWorkspace.files) {
    if (!dynamicPart.includes(relPath)) {
      ISSUES.push({ caseId, msg: `BuildWorkspace missing listed workspace path ${relPath}` });
    }
  }
}

function _validateDiscordSplit(staticPart, dynamicPart, id, caseId) {
  if (!DISCORD_CASES.includes(id)) return;
  if (staticPart.includes('BuildWorkspace')) {
    ISSUES.push({ caseId, msg: 'Discord static must not mention BuildWorkspace' });
  }
  // Statute is static (process-stable); thread title / emojis / events are
  // Runtime-only. conversation_title is in text.format on every turn, and its
  // rules live there — Runtime only carries the title to compare against.
  if (/Thread title:/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include Thread title (belongs in Runtime)' });
  }
  if (/(?:^|\n)\s*Emojis:/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include Emojis (belongs in Runtime)' });
  }
  if (/(?:^|\n)\s*Events:/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include Events (belongs in Runtime)' });
  }
  if (/<Statute>/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'statute must be static (not the Runtime block)' });
  }
  if (!/^## Server statute$/m.test(staticPart) || !/<Statute>[\s\S]*<\/Statute>/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'Discord case missing the "## Server statute" section' });
  }
  if (!/Thread title:/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'Discord Runtime missing Thread title line' });
  }
  // Field rules live in text.format only — never restate them in Runtime.
  if (/conversation_title/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'Discord Runtime must not restate conversation_title (schema only)' });
  }
  if (/cannot change the conversation title/i.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'Discord Runtime must not say the title cannot be changed' });
  }
  // Guild live fields appear only when the case supplies them.
  const ctx = _ctx(id);
  if (Boolean(ctx.availableEmojis) !== /Emojis:/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: `Emojis line in Runtime does not match the case (present: ${Boolean(ctx.availableEmojis)})` });
  }
  if (Boolean(ctx.serverEvents) !== /Events:/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: `Events line in Runtime does not match the case (present: ${Boolean(ctx.serverEvents)})` });
  }
}

/** "Who you are talking to": exactly one branch, matching the caller. */
function _validateAudience(staticPart, id, caseId) {
  const audience = _promptSection(staticPart, 'Who you are talking to');
  if (!audience) {
    ISSUES.push({ caseId, msg: 'missing "## Who you are talking to" body' });
    return;
  }
  const isNonActive = NON_ACTIVE_CASES.includes(id);
  const isDiscordCase = DISCORD_CASES.includes(id);
  // Read the branch off the section's opening line, which is where
  // buildAudienceLines states it. Scanning the whole section would also hit
  // the active branch's closing "Someone who is not an active member gets
  // none of it", and pinning an exact sentence breaks on any rewording.
  const branchLine = audience.trim().split('\n')[0] || '';
  const saysActive = /\bis an active\b/.test(branchLine);
  const saysNotActive = /\bis not an active\b/.test(branchLine);
  if (saysActive === saysNotActive) {
    ISSUES.push({ caseId, msg: 'audience section must state exactly one membership branch' });
  } else if (isNonActive !== saysNotActive) {
    ISSUES.push({ caseId, msg: `audience branch does not match the caller (non-active case: ${isNonActive})` });
  }
  if (isNonActive) {
    if (/<ActiveMembers>/.test(audience)) {
      ISSUES.push({ caseId, msg: 'non-active caller must not get the ActiveMembers roster' });
    }
  } else {
    if (!/<ActiveMembers>[^\n]*<\/ActiveMembers>/.test(audience)) {
      ISSUES.push({ caseId, msg: 'active member missing the ActiveMembers roster' });
    }
    // The roster carries identifiers only for the admin, names only otherwise.
    const hasIdentifiers = /<ActiveMembers>[^\n]*@[^\n]*<\/ActiveMembers>/.test(audience);
    if (NON_ADMIN_ACTIVE_CASES.includes(id) === hasIdentifiers) {
      ISSUES.push({ caseId, msg: 'roster detail does not match admin status (identifiers are admin-only)' });
    }
    // Only claim reach the live schema actually grants.
    const claimed = ['send_whatsapp_message', 'send_email', 'read_music_stats', 'read_sent_messages']
      .filter(t => audience.includes(t));
    const expectedReach = isDiscordCase
      ? ['send_whatsapp_message', 'send_email']
      : ['send_whatsapp_message', 'send_email', 'read_music_stats', 'read_sent_messages'];
    if (claimed.join(',') !== expectedReach.join(',')) {
      ISSUES.push({ caseId, msg: `audience claims the wrong member tools: ${claimed.join(',') || 'none'}` });
    }
    if (isDiscordCase && /schedule_tasks/.test(audience)) {
      ISSUES.push({ caseId, msg: 'schedule_tasks does not exist on Discord' });
    }
  }
  // read_server_rules is gone: WhatsApp redirects statute questions to Discord.
  const redirects = /gemix thread on Discord/.test(audience);
  if (!isDiscordCase && !isNonActive && !redirects) {
    ISSUES.push({ caseId, msg: 'WhatsApp active member missing the statute redirect to Discord' });
  }
  if (isDiscordCase && redirects) {
    ISSUES.push({ caseId, msg: 'Discord must not redirect statute questions to itself' });
  }
}

/** "What you can and cannot see" keeps the notations the history actually uses. */
function _validateVisibility(staticPart, caseId, providerId) {
  const visibility = _promptSection(staticPart, 'What you can and cannot see');
  if (!visibility) return;
  if (!visibility.includes('The user sees only the chat history and your final reply')) {
    ISSUES.push({ caseId, msg: 'visibility section missing the "user sees only" line' });
  }
  if (!visibility.includes('[Reactions: emoji xN]')) {
    ISSUES.push({ caseId, msg: 'visibility section missing [Reactions: emoji xN] notation' });
  }
  const provider = getProviderProfile(providerId);
  if (provider.capabilities.xSearch && !/videos inside X posts/.test(visibility)) {
    ISSUES.push({ caseId, msg: 'visibility section missing the web-image / X-video capability line' });
  }
  if (provider.id === PROVIDER.OPENAI) {
    if (!/raw content is never loaded|Raw video content is unavailable/.test(visibility)) {
      ISSUES.push({ caseId, msg: 'OpenAI visibility must say raw video content is unavailable' });
    }
    if (/Videos are the exception:[^\n]*are loaded|videos included,[^\n]*you can only read/i.test(visibility)) {
      ISSUES.push({ caseId, msg: 'OpenAI visibility falsely claims raw videos can be loaded or read' });
    }
  }
}

/** OpenAI must explain provider-owned X/video gaps without offering a switch. */
function _validateProviderUnavailableRule(staticPart, caseId, providerId) {
  if (providerId !== PROVIDER.OPENAI) return;
  const answer = _promptSection(staticPart, 'How you answer') || '';
  if (!/administrator configured GemiX with ChatGPT/.test(answer) || !/users cannot change that setting/.test(answer)) {
    ISSUES.push({ caseId, msg: 'OpenAI prompt missing the admin-configured ChatGPT X/video unavailable rule' });
  }
}

/** "This chat" is the only place that states what renders and what is appended. */
function _validateThisChat(staticPart, id, caseId, providerId) {
  const chat = _promptSection(staticPart, 'This chat');
  if (!chat) return;
  if (!WHATSAPP_CASES.includes(id)) {
    if (/system appends/.test(chat)) {
      ISSUES.push({ caseId, msg: 'Discord appends no footer or source list' });
    }
    if (chat.includes(PRIVACY_WIPE_COMMAND)) {
      ISSUES.push({ caseId, msg: `Discord must not mention ${PRIVACY_WIPE_COMMAND} (WhatsApp-only)` });
    }
    return;
  }
  for (const token of ['*bold*', '```', '"- " bullets', '"1. " numbered lists']) {
    if (!chat.includes(token)) {
      ISSUES.push({ caseId, msg: `WhatsApp format line missing ${token}` });
    }
  }
  if (!/the system appends those itself/.test(chat)) {
    ISSUES.push({ caseId, msg: 'WhatsApp case missing the "system appends the footer" line' });
  }
  // Citations must read as required, and must name whatever produces them on
  // this profile: the backend directive on xAI, the hosted search on OpenAI.
  const citesMechanism = getProviderProfile(providerId).searchStatsExtractor === 'openai'
    ? /sources behind a web search come back with the answer/.test(chat)
    : /sources you mark with render_inline_citation/.test(chat);
  if (!citesMechanism || !/"Fonti:" list/.test(chat)) {
    ISSUES.push({ caseId, msg: 'WhatsApp case must say how sources are cited and let the system build the list' });
  }
  // Groups mention by phone digits; one-to-one chats have no mentions at all.
  const wantsMentions = _ctx(id).isGroup === true;
  const hasMentionRule = /@<phone digits>/.test(chat);
  const hasNoTagRule = /mentions only work in groups/.test(chat);
  if (wantsMentions ? !hasMentionRule : !hasNoTagRule) {
    ISSUES.push({ caseId, msg: `WhatsApp case missing its tagging rule (group: ${wantsMentions})` });
  }
  // The wipe command exists only on WhatsApp, and the model must be told
  // both that it never reaches it and what a readable attempt means.
  if (!chat.includes(PRIVACY_WIPE_COMMAND)) {
    ISSUES.push({ caseId, msg: `WhatsApp case missing the ${PRIVACY_WIPE_COMMAND} privacy command line` });
  } else if (!/never reaches you/.test(chat) || !/failed because/.test(chat)) {
    ISSUES.push({ caseId, msg: 'privacy command line must say it never reaches the model and what a readable attempt means' });
  } else if (!/never bring that up yourself/.test(chat)) {
    ISSUES.push({ caseId, msg: 'privacy command line missing the silent-acceptance rule' });
  }
}

/**
 * Weekly media generation quota line: shown to non-admin callers on platforms
 * exposing all three generation tools (WhatsApp); hidden for admins and Discord.
 */
function _validateQuotaLine(dynamicPart, id, caseId, providerId) {
  const hasQuotaLine = /Weekly generation quota for this user/.test(dynamicPart);
  const ctx = _ctx(id, providerId);
  const kinds = quotaKindsForProfile(resolveProfile(ctx), ctx);
  if (!_groups(providerId).quota.includes(id) || kinds.length === 0) {
    if (hasQuotaLine) {
      ISSUES.push({ caseId, msg: 'weekly media quota line must not appear (admin, or nothing metered here)' });
    }
    return;
  }
  if (!hasQuotaLine) {
    ISSUES.push({ caseId, msg: 'missing weekly media quota line in Runtime (non-admin on a media platform)' });
    return;
  }
  // A counter the provider cannot generate is left out entirely, so losing
  // video must never take the image or song counters with it.
  const mask = (text) => text.replace(/: \d+\//g, ': N/');
  const expected = mask(formatQuotaCounts('__validator__', kinds));
  const found = dynamicPart.match(/(?:Video|Immagini|Canzoni): \d+\/\d+(?: · (?:Video|Immagini|Canzoni): \d+\/\d+)*/);
  const actual = found ? mask(found[0]) : '(none)';
  if (actual !== expected) {
    ISSUES.push({ caseId, msg: `weekly media quota line is "${actual}", expected "${expected}"` });
  }
}

/** Per-chat preferences block: WhatsApp only, in Runtime, with default/custom markers. */
function _validateSettingsBlocks(dynamicPart, prompt, id, caseId) {
  const settingsBlock = dynamicPart.match(/<CurrentSettings[\s\S]*?<\/CurrentSettings>/);
  if (!WHATSAPP_CASES.includes(id)) {
    if (settingsBlock) {
      ISSUES.push({ caseId, msg: 'CurrentSettings must not appear on this platform' });
    }
  } else if (!settingsBlock) {
    ISSUES.push({ caseId, msg: 'WhatsApp case missing CurrentSettings block in Runtime' });
  } else {
    for (const field of ['Voice:', 'Effort:', 'Language:', 'Memory:', 'Last update:']) {
      if (!settingsBlock[0].includes(field)) {
        ISSUES.push({ caseId, msg: `CurrentSettings missing "${field}" line` });
      }
    }
    if (!/\((default|custom)\)/.test(settingsBlock[0])) {
      ISSUES.push({ caseId, msg: 'CurrentSettings missing (default)/(custom) markers' });
    }
    if (prompt.includes('<Memory>')) {
      ISSUES.push({ caseId, msg: 'obsolete <Memory> block (folded into <CurrentSettings>)' });
    }
    // Customized cases must be flagged as custom, all-default ones never.
    const wantsCustom = CUSTOM_SETTINGS_CASES.includes(id);
    if (wantsCustom !== /\(custom\)/.test(settingsBlock[0])) {
      ISSUES.push({ caseId, msg: `(custom) marker does not match the case settings (custom: ${wantsCustom})` });
    }
  }

  // Monthly renewal notice: only when the case marks the review as due.
  const review = dynamicPart.match(/<SettingsReview>[\s\S]*?<\/SettingsReview>/);
  if (!REVIEW_DUE_CASES.includes(id)) {
    if (review) ISSUES.push({ caseId, msg: 'SettingsReview must not appear when no review is due' });
  } else if (!review) {
    ISSUES.push({ caseId, msg: 'missing SettingsReview block in Runtime (review due)' });
  } else if (!/manage_preferences/.test(review[0])) {
    ISSUES.push({ caseId, msg: 'SettingsReview should point at manage_preferences' });
  }
}

/**
 * @param {string} staticPart - the role:system prefix at input[0]
 * @param {string} dynamicPart - the per-turn Runtime block
 * @param {string|number} caseId
 */
function validatePrompt(staticPart, dynamicPart, caseId, providerId) {
  const prompt = `${staticPart}\n${dynamicPart}`;
  const id = Number(caseId);

  if (!/^You are \S/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must open with the identity sentence ("You are …")' });
    return;
  }
  if (!dynamicPart.startsWith('<Runtime>')) {
    ISSUES.push({ caseId, msg: 'dynamic missing leading <Runtime>' });
    return;
  }

  _validateStaticShape(staticPart, prompt, caseId, providerId);
  _validateNoStaleClaims(staticPart, prompt, caseId);
  _validateStaticDynamicSplit(staticPart, dynamicPart, caseId);
  _validateBuildWorkspace(dynamicPart, id, caseId);
  _validateDiscordSplit(staticPart, dynamicPart, id, caseId);
  _validateAudience(staticPart, id, caseId);
  _validateVisibility(staticPart, caseId, providerId);
  _validateProviderUnavailableRule(staticPart, caseId, providerId);
  _validateThisChat(staticPart, id, caseId, providerId);
  _validateQuotaLine(dynamicPart, id, caseId, providerId);
  _validateSettingsBlocks(dynamicPart, prompt, id, caseId);
  validateNoImplLeaks(prompt, caseId, 'system prompt');
}

// -- Build sub-agent -------------------------------------------------------

/** The `--rules` text handed to Grok Build, sliced out of the build dump. */
function _validateBuildRules(rulesText) {
  if (typeof rulesText !== 'string' || !rulesText.trim()) {
    ISSUES.push({ caseId: 'build', msg: 'build rules text empty' });
    return;
  }
  if (!/GemiX-Build/i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules missing GemiX-Build identity' });
  }
  if (!/\/workspace\//i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules missing /workspace/' });
  }
  if (!/harvests|delivery buffer|GemiX-Main will select/i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules missing harvest / delivery buffer contract' });
  }
  if (!/HTTP_PROXY|HTTPS_PROXY|residential/i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules missing proxy/network guidance' });
  }
  if (!/do not (emit|list) JSON attachments/i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules still imply JSON attachments schema' });
  }
  if (/\/skills\//i.test(rulesText)) {
    ISSUES.push({ caseId: 'build', msg: 'build rules must not require GemiX /skills/ packs' });
  }
  validateNoImplLeaks(rulesText, 'build', 'build grok rules');
}

/** The main-brain `build` tool description, read off the live schema. */
function _validateBuildToolDescription(platform, providerId) {
  const profile = getProviderProfile(providerId);
  const tools = getToolsForUser(true, true, { platform, isGroup: false, providerProfile: profile });
  const desc = tools.find(t => t?.function?.name === 'build')?.function?.description || '';
  if (!profile.capabilities.build) {
    if (desc) ISSUES.push({ caseId: 'build', msg: 'build tool is exposed on a profile that has no build runner' });
    return;
  }
  if (!/delivery buffer/i.test(desc)) {
    ISSUES.push({ caseId: 'build', msg: 'main build tool description missing delivery buffer harvest wording' });
  }
  if (!/final `attachments`|final attachments/i.test(desc)) {
    ISSUES.push({ caseId: 'build', msg: 'main build tool description missing GemiX attachment selection wording' });
  }
  if (/Skills:/i.test(desc)) {
    ISSUES.push({ caseId: 'build', msg: 'main build tool description still lists GemiX skill packs' });
  }
  if (/&lt;BuildWorkspace&gt;/.test(desc)) {
    ISSUES.push({ caseId: 'build', msg: 'main build tool description should use raw <BuildWorkspace> not HTML entities' });
  }
  const runnerName = profile.id === PROVIDER.OPENAI ? 'Codex Build' : 'Grok Build';
  if (!new RegExp(`resend|full ${runnerName}`, 'i').test(desc)) {
    ISSUES.push({ caseId: 'build', msg: `main build tool description should note resend still runs full ${runnerName}` });
  }
}

/**
 * @param {string} buildDump - full build-agent-dump.txt text
 * @param {string} platform - platform to read the live `build` tool schema from
 */
function validateBuildAgentDump(buildDump, platform, providerId) {
  const marker = '--- DEVELOPER INSTRUCTIONS ---';
  // The dump is still written when the runner is gated off — it is how the
  // gate itself is reviewed — but the tool must be absent from the schema.
  _validateBuildToolDescription(platform, providerId);
  if (!getProviderProfile(providerId).capabilities.build) {
    if (!/CODEX_BUILD_ENABLED/.test(buildDump)) {
      ISSUES.push({ caseId: 'build', msg: 'a gated build dump must state which flag gates it' });
    }
    return;
  }
  const rulesStart = buildDump.indexOf(marker);
  if (rulesStart < 0) {
    ISSUES.push({ caseId: 'build', msg: 'build dump missing the developer instructions section' });
  } else {
    const rulesEnd = buildDump.indexOf('\n--- EXEC', rulesStart);
    const slice = rulesEnd >= 0
      ? buildDump.slice(rulesStart + marker.length, rulesEnd)
      : buildDump.slice(rulesStart + marker.length);
    _validateBuildRules(slice.trim());
  }
  validateToolDumpLeaks(buildDump, 'build');
}

export {
  ISSUES,
  validatePrompt,
  validateResponseFormat,
  validateToolDumpLeaks,
  validateBuildAgentDump,
  validateProviderIsolation
};
