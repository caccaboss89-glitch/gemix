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
import { getCapabilities } from '../../src/config/platformCapabilities.js';
import { getToolsForUser } from '../../src/ai/tools.js';
import {
  PROMPT_VARIANT,
  resolveProviderProfile
} from '../../src/ai/providers/providerProfile.js';
import {
  customizedFields,
  defaultSettings
} from '../../src/utils/settingsStore.js';
import { listInstalledSkills } from '../../src/sandbox/skillsLibrary.js';
import { CASES } from './cases.js';

const { PLATFORM_DISCORD } = constants;

const ISSUES = [];

const XAI_GUIDANCE_RE = /\bxAI\b|\bGrok\b|\bx_search\b|X posts|X\/Twitter|CDN URL|SuperGrok/i;

function _containsXaiOnlyMaterial(text) {
  return XAI_GUIDANCE_RE.test(text);
}

/** Remove program data whose literal contents are not model instructions. */
function _withoutStaticProgramData(text) {
  return String(text || '')
    .replace(/<ActiveMembers>[\s\S]*?<\/ActiveMembers>/g, '')
    .replace(/<Statute>[\s\S]*?<\/Statute>/g, '');
}

// -- Case groupings, all derived from CASES --------------------------------

const caseIds = Object.keys(CASES).map(Number);
const _ctx = (id) => CASES[id].ctx;
const _is = (pred) => caseIds.filter(i => pred(_ctx(i)));

const DISCORD_CASES = _is(c => c.platform === PLATFORM_DISCORD);
const WHATSAPP_CASES = _is(c => c.platform !== PLATFORM_DISCORD);
const NON_ACTIVE_CASES = _is(c => c.userIdentity?.isActiveMember === false);
const NON_ADMIN_ACTIVE_CASES = _is(c => c.userIdentity?.isActiveMember !== false && !c.userIdentity?.isAdmin);
const VOICE_CASES = caseIds.filter(i => getCapabilities(_ctx(i)).voiceReply);
const CUSTOM_SETTINGS_CASES = _is(c => c.settings !== undefined);
const REVIEW_DUE_CASES = _is(c => c.settingsReviewDue === true);

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
  { re: /Added to the current turn/i, label: 'Added to the current turn' },
  { re: /render_inline_citation/i, label: 'legacy render_inline_citation' },
  { re: /\[\[[^\]]*\]\]\(https?:/i, label: 'legacy inline source marker' }
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
  const toolText = dump.slice(toolsStart);
  validateNoImplLeaks(toolText, caseId, 'tool schema');
  if (toolText.includes('[function] schedule_tasks')) {
    if (!/wall-clock time unchanged/.test(toolText)
        || !/Do not convert the hour/.test(toolText)
        || !/do not add Z or a UTC offset/.test(toolText)) {
      ISSUES.push({
        caseId,
        msg: 'schedule_tasks must tell the model to copy wall-clock time unchanged and leave timezone conversion to the backend'
      });
    }
  }
  const ctx = _ctx(Number(caseId));
  if (ctx) {
    const hasBugReport = toolText.includes('[function] bug_report');
    if (Boolean(ctx.userIdentity?.isAdmin) === hasBugReport) {
      ISSUES.push({ caseId, msg: 'bug_report availability does not match administrator status' });
    }
    const generic = resolveProviderProfile().promptVariant === PROMPT_VARIANT.GENERIC;
    if (generic && _containsXaiOnlyMaterial(toolText)) {
      ISSUES.push({ caseId, msg: 'generic provider tool schema leaks xAI-only material' });
    }
    const nativeX = toolText.match(/\[native\] (\{[^\n]+"type":"x_search"[^\n]+\})/);
    if (nativeX) {
      let schema;
      try { schema = JSON.parse(nativeX[1]); } catch { schema = null; }
      if (!schema
          || Object.hasOwn(schema, 'limit')
          || schema?.enable_image_understanding !== true
          || schema?.enable_video_understanding !== true) {
        ISSUES.push({ caseId, msg: 'native x_search dump must omit the obsolete limit and keep both media-understanding flags' });
      }
    }
  }
}

// -- Structured output -----------------------------------------------------

function validateResponseFormat(dump, caseId) {
  const fmtStart = dump.indexOf('--- STRUCTURED OUTPUT');
  if (fmtStart < 0) return;
  const fmtEnd = dump.indexOf('\n--- AUDIT APPENDIX', fmtStart);
  const fmt = fmtEnd >= 0 ? dump.slice(fmtStart, fmtEnd) : dump.slice(fmtStart);
  const hasVoice = /voice \(boolean, required\)/.test(fmt);
  const hasSpokenDesc = /natural spoken words/.test(fmt);
  const hasTitle = /conversation_title \(string, required\)/.test(fmt);
  const id = Number(caseId);

  if (VOICE_CASES.includes(id)) {
    if (!hasVoice) ISSUES.push({ caseId, msg: 'WA dedicated case missing voice schema field' });
    if (!hasSpokenDesc) ISSUES.push({ caseId, msg: 'voice case missing natural spoken-word instructions' });
  } else {
    if (hasVoice) ISSUES.push({ caseId, msg: 'non-voice case must not expose voice schema field' });
    if (hasSpokenDesc) ISSUES.push({ caseId, msg: 'non-voice case must not expose spoken-word instructions in response schema' });
  }
  // conversation_title is required in text.format on every Discord turn.
  if (DISCORD_CASES.includes(id)) {
    if (!hasTitle) ISSUES.push({ caseId, msg: 'Discord text.format must require conversation_title' });
  } else if (hasTitle) {
    ISSUES.push({ caseId, msg: 'non-Discord case must not expose conversation_title schema field' });
  }
  if (!/schema: object additionalProperties=false required=\[[^\]]*response[^\]]*attachments/.test(fmt)) {
    ISSUES.push({ caseId, msg: 'structured reply dump must expose its closed object and required fields' });
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

/** Prose shape, section order and blocks forbidden by the current contract. */
function _validateStaticShape(staticPart, prompt, caseId) {
  // Prose sections, in order. XML is reserved for program data.
  const headings = [...staticPart.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  const required = [
    'Provider integration',
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
  const expectedModel = resolveProviderProfile().displayName;
  if (!opening.includes(expectedModel)) {
    ISSUES.push({ caseId, msg: `opening missing model display name "${expectedModel}"` });
  }
  if (/Grok\/SuperGrok|Gemini|a fusion of/i.test(opening)) {
    ISSUES.push({ caseId, msg: 'opening contains obsolete provider history' });
  }
  if (!opening.includes('<user_query>')) {
    ISSUES.push({ caseId, msg: 'opening must point at the <user_query> tag as the goal' });
  }
  // Only program data may open a line with a tag; instructions are prose. The
  // skill index spans several lines, so its closing tag opens one too.
  for (const line of staticPart.split('\n')) {
    if (!line.startsWith('<')) continue;
    if (/^<\/?(ActiveMembers|Statute|Skills)>/.test(line)) continue;
    ISSUES.push({ caseId, msg: `static instruction rendered as XML: ${line.slice(0, 48)}` });
    break;
  }
  // Instructions are prose sections; XML-like scaffolding is forbidden.
  for (const gone of ['<Context>', '<Directives>', '<PreSendCheck>', '<Platform', '<Limits>', '<Identity>', '<Conduct>', '<Style>', '<Grounding>', '<Tooling>', 'Rules context:']) {
    if (staticPart.includes(gone)) {
      ISSUES.push({ caseId, msg: `static contains forbidden block ${gone}` });
    }
  }
  if (/R\d+ \[(always|out|reply|tool)\]/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static still numbers directives R<n> [scope]' });
  }
  // These concepts belong in prose sections, never top-level XML blocks.
  for (const gone of ['<Rules>', '<ToolUsage>', '<Capabilities>', '<Conversation>', '<Memory>', '<Reactions>', '<Visibility>']) {
    if (prompt.includes(gone)) {
      ISSUES.push({ caseId, msg: `forbidden top-level block ${gone}` });
    }
  }
  if (/\s+\n<\/[A-Za-z]+>/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'trailing whitespace before a closing tag' });
  }
}

/** Claims forbidden on either side of the static/dynamic split. */
function _validateNoStaleClaims(staticPart, prompt, caseId) {
  if (/render_inline_citation|"Fonti:" list|inline citations|url_citation/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'prompt contains the removed provider citation mechanism' });
  }
  if (/system prompt Format line/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'invalid cross-reference to "Format line"' });
  }
  if (/read_server_rules/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'read_server_rules is not in the tool catalog' });
  }
  if (prompt.includes('native processing via tunnel')) {
    ISSUES.push({ caseId, msg: 'contains native processing via tunnel' });
  }
  if (/all audio\/video|tutti.*audio\/video/i.test(prompt) && /temp link|link temporaneo/i.test(prompt)) {
    ISSUES.push({ caseId, msg: 'unsupported proactive all A/V temp-link policy in prompt' });
  }
  // The buffer is always empty when the Runtime block is built, so it is
  // described in prose and each tool result names its own file instead.
  if (/<DeliveryBuffer>/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'DeliveryBuffer is forbidden: tool results name their own files' });
  }
  // conversation_title rules live in text.format only.
  if (/conversation_title/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not mention conversation_title (text.format only)' });
  }
  if (/First message of this thread/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not claim a first-turn-only title rule' });
  }
  if (/Any other file you can only read when it is in this chat/.test(prompt)) {
    ISSUES.push({ caseId, msg: 'visibility must account for files downloaded into the workspace' });
  }
}

/** Exactly one provider block: generic baseline or its complete xAI replacement. */
function _validateProviderGuidance(staticPart, caseId) {
  const guidance = _promptSection(staticPart, 'Provider integration');
  if (!guidance) return;
  const variant = resolveProviderProfile().promptVariant;
  if (variant === PROMPT_VARIANT.XAI) {
    if (!/Regular web search[\s\S]*GemiX-owned/.test(guidance) || !/native X search/.test(guidance)) {
      ISSUES.push({ caseId, msg: 'xAI provider block missing its GemiX-web / native-X boundary' });
    }
    const withoutOpeningAndProvider = _withoutStaticProgramData(
      staticPart.slice(staticPart.indexOf('\n## This chat\n'))
    );
    if (_containsXaiOnlyMaterial(withoutOpeningAndProvider)) {
      ISSUES.push({ caseId, msg: 'xAI-only operating guidance escaped the provider integration block' });
    }
    return;
  }
  if (!/model provider supplies reasoning, vision, structured replies/i.test(guidance)
      || !/GemiX itself supplies every user-facing feature/i.test(guidance)) {
    ISSUES.push({ caseId, msg: 'generic provider block missing the baseline provider contract' });
  }
  if (_containsXaiOnlyMaterial(_withoutStaticProgramData(staticPart))) {
    ISSUES.push({ caseId, msg: 'generic provider prompt contains an xAI-only instruction or identifier' });
  }
}

/** Turn-varying material must sit in Runtime, never in the cached static prefix. */
function _validateStaticDynamicSplit(staticPart, dynamicPart, caseId) {
  const ctx = _ctx(Number(caseId));
  if (/Time \(Europe\/Rome\)/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include Time (belongs in the Runtime block)' });
  }
  if (!/Time \(Europe\/Rome\)/.test(dynamicPart)) {
    ISSUES.push({ caseId, msg: 'dynamic Runtime missing Time' });
  }
  // Prose may name a Runtime tag (`<CurrentSettings>`); what static must never
  // carry is the block itself, which only ever opens a line.
  for (const tag of ['CurrentSettings', 'Workspace', 'SettingsReview', 'Caller']) {
    if (new RegExp(`^<${tag}[ >]`, 'm').test(staticPart)) {
      ISSUES.push({ caseId, msg: `static must not include the ${tag} block (belongs in Runtime)` });
    }
  }
  if (/Generation quota for this user/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not include media quota line (belongs in Runtime)' });
  }
  // Caller identity is Runtime-only: it changes turn to turn.
  if (!dynamicPart.includes('<Caller>')) {
    ISSUES.push({ caseId, msg: 'Runtime missing <Caller>' });
  }
  const callerSaysAdmin = /<Caller>[^<]*\(Discord server administrator, active member\)/.test(dynamicPart);
  if (Boolean(ctx?.userIdentity?.isAdmin) !== callerSaysAdmin) {
    ISSUES.push({ caseId, msg: 'Runtime caller administrator label does not match identity' });
  }
  if (/^(Caller|Participants):/m.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'static must not name the caller or the roster (belongs in Runtime)' });
  }
}

function _validateWorkspaceBlock(dynamicPart, id, caseId) {
  if (!WHATSAPP_CASES.includes(id)) return;
  const snapshot = _ctx(id).userWorkspace;
  const state = snapshot?.state || (snapshot ? 'ready' : 'unknown');
  if (!dynamicPart.includes(`<Workspace state="${state}"`)) {
    ISSUES.push({ caseId, msg: 'WhatsApp case missing Workspace block in Runtime' });
    return;
  }
  if (state !== 'ready') return;

  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const dirs = Array.isArray(snapshot?.dirs) ? snapshot.dirs : [];
  const total = Number.isFinite(snapshot?.total) ? snapshot.total : files.length;
  if (!dynamicPart.includes(`files="${total}" directories="${dirs.length}"`)) {
    ISSUES.push({ caseId, msg: 'Workspace snapshot counts do not match its files and directories' });
  }
  // Every listed file carries its full namespace path, because that same
  // string is what the model passes back to read_file and to attachments[].
  for (const { relPath } of files) {
    if (!dynamicPart.includes(`workspace/${relPath}`)) {
      ISSUES.push({ caseId, msg: `Workspace block missing listed path workspace/${relPath}` });
    }
  }
  for (const relPath of dirs) {
    if (!dynamicPart.includes(`workspace/${relPath}/`)) {
      ISSUES.push({ caseId, msg: `Workspace block missing listed directory workspace/${relPath}/` });
    }
  }
}

function _validateDiscordSplit(staticPart, dynamicPart, id, caseId) {
  if (!DISCORD_CASES.includes(id)) return;
  if (/<Workspace[ >]/.test(staticPart)) {
    ISSUES.push({ caseId, msg: 'Discord static must not carry a Workspace block' });
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
function _validateVisibility(staticPart, caseId) {
  const visibility = _promptSection(staticPart, 'What you can and cannot see');
  if (!visibility) return;
  if (!visibility.includes('The user sees only the chat history and your final reply')) {
    ISSUES.push({ caseId, msg: 'visibility section missing the "user sees only" line' });
  }
  if (!visibility.includes('[Reactions: emoji xN]')) {
    ISSUES.push({ caseId, msg: 'visibility section missing [Reactions: emoji xN] notation' });
  }
  if (!/A remote URL by itself is not content you have inspected/.test(visibility)) {
    ISSUES.push({ caseId, msg: 'visibility section missing the remote-content inspection boundary' });
  }
}

/** "This chat" is the only place that states what renders and what is appended. */
function _validateThisChat(staticPart, id, caseId) {
  const chat = _promptSection(staticPart, 'This chat');
  if (!chat) return;
  if (!WHATSAPP_CASES.includes(id)) {
    if (!chat.includes('Platform: Discord.')) {
      ISSUES.push({ caseId, msg: 'Discord This chat section must name the platform explicitly' });
    }
    if (/system appends/.test(chat)) {
      ISSUES.push({ caseId, msg: 'Discord appends no footer or source list' });
    }
    if (chat.includes(PRIVACY_WIPE_COMMAND)) {
      ISSUES.push({ caseId, msg: `Discord must not mention ${PRIVACY_WIPE_COMMAND} (WhatsApp-only)` });
    }
    return;
  }
  if (!chat.includes('Platform: WhatsApp.')) {
    ISSUES.push({ caseId, msg: 'WhatsApp This chat section must name the platform explicitly' });
  }
  for (const token of ['*bold*', '```', '"- " bullets', '"1. " numbered lists']) {
    if (!chat.includes(token)) {
      ISSUES.push({ caseId, msg: `WhatsApp format line missing ${token}` });
    }
  }
  if (!/program appends its own compact model and research badges/.test(chat)) {
    ISSUES.push({ caseId, msg: 'WhatsApp case missing the program-owned badge line' });
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

/** File inspection strategy belongs to the workspace, not to one tool schema. */
function _validateWorkspaceGuidance(staticPart, caseId) {
  const workspace = _promptSection(staticPart, 'Your workspace');
  if (!workspace) return;
  if (!/standard gateway that brings its contents into your context/.test(workspace)) {
    ISSUES.push({ caseId, msg: 'workspace guidance must identify read_file as the standard context gateway' });
  }
  if (/only way to open a file/.test(workspace)) {
    ISSUES.push({ caseId, msg: 'workspace guidance must not contradict shell-based file processing' });
  }
  if (!/result is incomplete or insufficient/.test(workspace) || !/missing pages or tables/.test(workspace)
    || !/pages or slide images/.test(workspace) || !/use `shell`/.test(workspace)) {
    ISSUES.push({ caseId, msg: 'workspace guidance lacks the fallback for incomplete document extraction' });
  }
}

/**
 * The skill library, as the prompt advertises it. Only the frontmatter belongs
 * here — the procedure is in the SKILL.md the model opens — so the section is
 * checked against the live library rather than against fixed text.
 *
 * The library is a WhatsApp surface, so a Discord prompt must carry neither the
 * section nor any mention of the root behind it.
 */
function _validateSkills(staticPart, id, caseId) {
  const skills = _promptSection(staticPart, 'Skills');
  const installed = listInstalledSkills();
  if (DISCORD_CASES.includes(id)) {
    if (skills) ISSUES.push({ caseId, msg: 'Discord must not carry a Skills section' });
    if (/skills\//.test(staticPart)) {
      ISSUES.push({ caseId, msg: 'Discord prompt names the `skills/` root, which does not exist there' });
    }
    return;
  }
  if (!skills) {
    if (installed.length > 0) {
      ISSUES.push({ caseId, msg: 'skill library is installed but the prompt carries no Skills section' });
    }
    return;
  }
  for (const skill of installed) {
    if (!skills.includes(`<Skill name="${skill.name}" path="${skill.path}">`)) {
      ISSUES.push({ caseId, msg: `Skills section missing "${skill.name}"` });
    }
  }
  const advertised = (skills.match(/<Skill /g) || []).length;
  if (advertised !== installed.length) {
    ISSUES.push({ caseId, msg: `Skills section lists ${advertised} skills, library holds ${installed.length}` });
  }
  // The section is an index. A procedure written into it would be paid for on
  // every turn of every chat, which is the cost the library exists to avoid.
  if (!/read its SKILL.md/.test(skills)) {
    ISSUES.push({ caseId, msg: 'Skills section must send the model to the SKILL.md before acting' });
  }
  if (/```|^\d+\. /m.test(skills)) {
    ISSUES.push({ caseId, msg: 'Skills section carries procedure steps that belong in a SKILL.md' });
  }
  if (!/never mention them/.test(skills)) {
    ISSUES.push({ caseId, msg: 'Skills section must keep the library out of the answers' });
  }
}

/**
 * Media generation quota line: shown to non-admin callers for exactly the
 * generation tools available in this case, grouped by the period each resets on.
 */
function _validateQuotaLine(dynamicPart, id, caseId) {
  const hasQuotaLine = /Generation quota for this user/.test(dynamicPart);
  const ctx = _ctx(id);
  const liveNames = new Set(getToolsForUser({
    platform: ctx.platform,
    isGroup: Boolean(ctx.isGroup),
    isActiveMember: Boolean(ctx.userIdentity?.isActiveMember),
    isAdmin: Boolean(ctx.userIdentity?.isAdmin)
  }).map(tool => tool.function?.name || tool.type));
  const labels = [];
  if (liveNames.has('generate_image')) labels.push('Immagini');
  if (liveNames.has('generate_video')) labels.push('Video');
  if (liveNames.has('generate_music')) labels.push('Canzoni');
  const expected = !ctx.userIdentity?.isAdmin && labels.length > 0;
  if (!expected) {
    if (hasQuotaLine) {
      ISSUES.push({ caseId, msg: 'media quota line must not appear (admin or non-media platform)' });
    }
    return;
  }
  if (!hasQuotaLine) {
    ISSUES.push({ caseId, msg: 'missing media quota line in Runtime (non-admin on a media platform)' });
  } else {
    // Only the counts, without the sentence that follows them: the period
    // groups are split on ';' and the prose carries no reset boundary.
    const quotaLine = dynamicPart.match(/Generation quota for this user — (.+?)\. At the cap/)?.[1] || '';
    for (const label of labels) {
      if (!new RegExp(`${label}: \\d+\\/\\d+`).test(quotaLine)) {
        ISSUES.push({ caseId, msg: `media quota line missing ${label}` });
      }
    }
    for (const absent of ['Immagini', 'Video', 'Canzoni'].filter(label => !labels.includes(label))) {
      if (quotaLine.includes(`${absent}:`)) {
        ISSUES.push({ caseId, msg: `media quota line exposes unavailable ${absent}` });
      }
    }
    // Each period group states its own boundary, and images are the daily cap.
    for (const group of quotaLine.split(';')) {
      if (!/\(resets every [^)]+ at \d{2}:\d{2}\)/.test(group)) {
        ISSUES.push({ caseId, msg: 'media quota line lacks a reset boundary for one of its periods' });
      }
    }
    if (labels.includes('Immagini') && !/Immagini: \d+\/\d+ \(resets every day/.test(quotaLine)) {
      ISSUES.push({ caseId, msg: 'image quota must be stated as the daily one' });
    }
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
    const allowVoice = VOICE_CASES.includes(id);
    const fields = ['Effort:', 'Language:', 'Memory:', 'Last update:'];
    if (allowVoice) fields.unshift('Voice:');
    for (const field of fields) {
      if (!settingsBlock[0].includes(field)) {
        ISSUES.push({ caseId, msg: `CurrentSettings missing "${field}" line` });
      }
    }
    if (!allowVoice && settingsBlock[0].includes('Voice:')) {
      ISSUES.push({ caseId, msg: 'CurrentSettings exposes a voice selector on a text-only platform' });
    }
    if (!allowVoice && /voice:true|spoken replies|voice replies/i.test(settingsBlock[0])) {
      ISSUES.push({ caseId, msg: 'text-only platform exposes voice-reply guidance in CurrentSettings' });
    }
    if (!/\((default|custom)\)/.test(settingsBlock[0])) {
      ISSUES.push({ caseId, msg: 'CurrentSettings missing (default)/(custom) markers' });
    }
    if (prompt.includes('<Memory>')) {
      ISSUES.push({ caseId, msg: '<Memory> is forbidden; settings belong in <CurrentSettings>' });
    }
    // Customized cases must be flagged as custom, all-default ones never.
    const supplied = _ctx(id).settings;
    const preferenceOptions = { allowVoice };
    const wantsCustom = CUSTOM_SETTINGS_CASES.includes(id)
      && customizedFields({ ...defaultSettings(preferenceOptions), ...(supplied || {}) }, preferenceOptions).length > 0;
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
function validatePrompt(staticPart, dynamicPart, caseId) {
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

  _validateStaticShape(staticPart, prompt, caseId);
  _validateNoStaleClaims(staticPart, prompt, caseId);
  _validateProviderGuidance(staticPart, caseId);
  _validateStaticDynamicSplit(staticPart, dynamicPart, caseId);
  _validateWorkspaceBlock(dynamicPart, id, caseId);
  _validateDiscordSplit(staticPart, dynamicPart, id, caseId);
  _validateAudience(staticPart, id, caseId);
  _validateVisibility(staticPart, caseId);
  _validateThisChat(staticPart, id, caseId);
  _validateWorkspaceGuidance(staticPart, caseId);
  _validateSkills(staticPart, id, caseId);
  _validateQuotaLine(dynamicPart, id, caseId);
  _validateSettingsBlocks(dynamicPart, prompt, id, caseId);
  validateNoImplLeaks(prompt, caseId, 'system prompt');
}

// -- Workspace runtime -----------------------------------------------------

/**
 * The workspace-runtime dump is where the "no secret reaches the container"
 * rule is actually checkable: the exec environment is printed verbatim, so a
 * credential leaking into it fails the build instead of shipping.
 */
function _validateWorkspaceExecEnv(dump) {
  const marker = '--- EXEC ENV';
  const start = dump.indexOf(marker);
  if (start < 0) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace dump missing the exec env section' });
    return;
  }
  const end = dump.indexOf('\n--- EXEC:', start);
  const envText = end >= 0 ? dump.slice(start, end) : dump.slice(start);
  const forbidden = /API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|BEARER|AUTHORIZATION|OAUTH|_SECRET|_TOKEN\b/i;
  if (forbidden.test(envText)) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace exec env carries a credential-looking variable' });
  }
  if (!/HTTPS_PROXY/.test(envText)) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace exec env missing the fail-closed proxy settings' });
  }
}

/** The workspace tool descriptions, read off the live schema. */
function _validateWorkspaceToolDescriptions(platform) {
  const tools = getToolsForUser({ isActiveMember: true, isAdmin: true, platform, isGroup: false });
  const byName = new Map(tools.filter(t => t?.function).map(t => [t.function.name, t.function.description || '']));

  for (const name of ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']) {
    if (!byName.has(name)) {
      ISSUES.push({ caseId: 'workspace', msg: `main tool schema is missing "${name}"` });
    }
  }
  if (byName.has('build')) {
    ISSUES.push({ caseId: 'workspace', msg: 'the build sub-agent tool is still offered to the model' });
  }
  const readFile = byName.get('read_file') || '';
  if (!/bring a supported local file into your context/i.test(readFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'read_file description does not state its context-ingestion role' });
  }
  if (/whatever its format|only way to open|long or complex documents|use shell/i.test(readFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'read_file schema contains workspace-level strategy guidance' });
  }
  const editFile = byName.get('edit_file') || '';
  if (!/exactly once/i.test(editFile)) {
    ISSUES.push({ caseId: 'workspace', msg: 'edit_file description does not state the unique-match contract' });
  }
  const shell = byName.get('shell') || '';
  if (!/pip\/npm\/apt|package installs/i.test(shell)) {
    ISSUES.push({ caseId: 'workspace', msg: 'shell description does not state that package installs are disabled' });
  }
}

/**
 * @param {string} dump - full workspace-runtime-dump.txt text
 * @param {string} platform - platform to read the live tool schema from
 */
function validateWorkspaceRuntimeDump(dump, platform) {
  if (!dump || !dump.includes('=== WORKSPACE RUNTIME')) {
    ISSUES.push({ caseId: 'workspace', msg: 'workspace dump missing its header' });
    return;
  }
  _validateWorkspaceExecEnv(dump);
  _validateWorkspaceToolDescriptions(platform);
  validateToolDumpLeaks(dump, 'workspace');
}

export {
  ISSUES,
  validatePrompt,
  validateResponseFormat,
  validateToolDumpLeaks,
  validateWorkspaceRuntimeDump
};
