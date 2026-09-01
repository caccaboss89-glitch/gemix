import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDynamicRuntimeContext, buildStaticInstructions } from '../src/ai/systemPrompt.js';
import {
  _resetActiveProfileForTests
} from '../src/ai/providers/providerProfile.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';

const FIXTURE_MEMBERS = [{
  name: 'Fixture Member',
  wa: '390000000099@c.us',
  email: 'fixture@example.invalid'
}];

const FIXTURE_MEMBERS_WITH_ADMIN = [
  {
    name: 'Regular Member',
    wa: '390000000001@c.us',
    email: 'member@example.invalid'
  },
  {
    name: 'Test Admin',
    wa: '390000000099@c.us',
    email: 'admin@example.invalid',
    admin: true
  },
  {
    name: 'Legal Advisor',
    wa: '390000000002@c.us',
    email: 'legal@example.invalid',
    legal: true
  }
];

const XAI_ONLY_PROMPT_MATERIAL =
  /render_inline_citation|Grok\/SuperGrok|\bxAI\b|\bx_search\b|X posts/i;

function promptFor(isAdmin) {
  return buildStaticInstructions({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'fixture@c.us',
    userName: isAdmin ? 'Test Admin' : 'Fixture Member',
    userIdentity: { isActiveMember: true, isAdmin }
  }, undefined, { activeMembers: FIXTURE_MEMBERS });
}

test('Runtime tells the model when the current caller is the administrator', () => {
  const runtime = buildDynamicRuntimeContext({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'admin-fixture@c.us',
    userName: 'Test Admin',
    userIdentity: { isActiveMember: true, isAdmin: true, member: { name: 'Test Admin', admin: true } },
    userWorkspace: null
  });
  assert.match(runtime, /<Caller>Test Admin \(GemiX creator and Discord server administrator, active member\)/);
});

function underProvider(provider, fn) {
  const saved = envConfig.AI_PROVIDER;
  envConfig.AI_PROVIDER = provider;
  _resetActiveProfileForTests();
  try {
    return fn();
  } finally {
    envConfig.AI_PROVIDER = saved;
    _resetActiveProfileForTests();
  }
}

test('an injected prompt roster preserves admin-only identifiers without using deployment data', () => {
  assert.match(
    promptFor(true),
    /<ActiveMembers>Fixture Member \(\+390000000099, fixture@example\.invalid\)<\/ActiveMembers>/
  );
  assert.match(promptFor(false), /<ActiveMembers>Fixture Member<\/ActiveMembers>/);
  assert.doesNotMatch(
    promptFor(false),
    /390000000099|fixture@example\.invalid/
  );
});

test('a non-admin member sees the administrator labeled in the active members list', () => {
  const prompt = buildStaticInstructions({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'member-fixture@c.us',
    userName: 'Regular Member',
    userIdentity: { isActiveMember: true, isAdmin: false }
  }, undefined, { activeMembers: FIXTURE_MEMBERS_WITH_ADMIN });
  assert.match(
    prompt,
    /<ActiveMembers>Regular Member, Test Admin \(GemiX creator and Discord server administrator\), Legal Advisor \(Legal advisor\)<\/ActiveMembers>/
  );
});

test('Runtime tells the model when the current caller is a legal advisor', () => {
  const runtime = buildDynamicRuntimeContext({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'legal-fixture@c.us',
    userName: 'Legal Advisor',
    userIdentity: { isActiveMember: true, isAdmin: false, isLegal: true, member: { name: 'Legal Advisor', legal: true } },
    userWorkspace: null
  });
  assert.match(runtime, /<Caller>Legal Advisor \(Legal advisor, active member\)/);
});

test('generic and xAI provider guidance replace one another without legacy leaks', () => {
  const generic = underProvider('chatgpt', () => promptFor(false));
  assert.match(generic, /## Provider integration\nThe model provider supplies reasoning, vision, structured replies/);
  assert.doesNotMatch(
    generic,
    XAI_ONLY_PROMPT_MATERIAL
  );

  const xai = underProvider('xai', () => promptFor(false));
  assert.match(xai, /## Provider integration\nRegular web search[\s\S]*native X search/);
  assert.doesNotMatch(xai, /render_inline_citation|\[\[[^\]]*\]\]\(https?:|"Fonti:" list/i);
  const afterProviderBlock = xai.slice(xai.indexOf('\n## This chat\n'));
  assert.doesNotMatch(
    afterProviderBlock,
    XAI_ONLY_PROMPT_MATERIAL
  );
});

test('personal WhatsApp runtime never exposes spoken-reply defaults', () => {
  const runtime = underProvider('xai', () => buildDynamicRuntimeContext({
    platform: constants.PLATFORM_WA_PERSONAL,
    isGroup: false,
    chatId: 'personal-fixture@c.us',
    userName: 'Fixture Member',
    userIdentity: { isActiveMember: true, isAdmin: false },
    userWorkspace: null
  }));
  assert.match(runtime, /<CurrentSettings scope="chat">/);
  assert.doesNotMatch(runtime, /Voice:|voice:true|voice replies|spoken replies/i);
});

test('workspace runtime distinguishes an empty snapshot from unknown and failed snapshots', () => {
  const base = {
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'workspace-fixture@c.us',
    userName: 'Fixture Member',
    userIdentity: { isActiveMember: true, isAdmin: false }
  };
  const empty = buildDynamicRuntimeContext({
    ...base,
    userWorkspace: { state: 'ready', total: 0, files: [], dirs: [], more: false }
  });
  const unknown = buildDynamicRuntimeContext({ ...base, userWorkspace: null });
  const failed = buildDynamicRuntimeContext({ ...base, userWorkspace: { state: 'error' } });

  assert.match(empty, /<Workspace state="ready" files="0" directories="0">/);
  assert.match(empty, /empty at the start of this turn/);
  assert.doesNotMatch(empty, /expired/);
  assert.match(unknown, /<Workspace state="unknown">/);
  assert.match(unknown, /No reliable start-of-turn snapshot/);
  assert.match(failed, /<Workspace state="error">/);
  assert.match(failed, /do not describe the workspace as empty or expired/);
});

test('workspace runtime preserves a directory-only top-level snapshot', () => {
  const runtime = buildDynamicRuntimeContext({
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false,
    chatId: 'workspace-dir-fixture@c.us',
    userName: 'Fixture Member',
    userIdentity: { isActiveMember: true, isAdmin: false },
    userWorkspace: { state: 'ready', total: 0, files: [], dirs: ['reports'], more: false }
  });

  assert.match(runtime, /<Workspace state="ready" files="0" directories="1">/);
  assert.match(runtime, /- workspace\/reports\//);
  assert.doesNotMatch(runtime, /empty at the start of this turn/);
});

test('workspace guidance states shell path and proxy failures without false absolutes', () => {
  const prompt = promptFor(false);

  assert.match(prompt, /omit `workingDir` to start at `\/`/);
  assert.match(prompt, /use `\/workspace\/\.\.\.`, `\/attachments\/\.\.\.` or `\/skills\/\.\.\.`/);
  assert.match(prompt, /A 403 can be either a proxy policy rejection or the remote site refusing the request/);
  assert.doesNotMatch(prompt, /A 403 from it means the destination is not public/);
});

test('the Skills section and the `skills/` root are a WhatsApp surface only', () => {
  const wa = promptFor(true);
  assert.match(wa, /^## Skills$/m);
  assert.match(wa, /`skills\/` the skill library; both are mounted read-only/);
  assert.match(wa, /The library is read-only/);
  // Nothing may invite the model to add to a library it cannot write to.
  assert.equal(/\b(maintain|create|delete) (a |the )?skill/i.test(wa), false);

  const discord = buildStaticInstructions({
    platform: constants.PLATFORM_DISCORD,
    isGroup: false,
    chatId: 'channel123',
    userName: 'Test Admin',
    userIdentity: { isActiveMember: true, isAdmin: true }
  }, undefined, { activeMembers: FIXTURE_MEMBERS });

  assert.equal(/skill/i.test(discord), false, 'Discord names a library it does not have');
  assert.match(discord, /use `\/workspace\/\.\.\.` or `\/attachments\/\.\.\.` for a root-stable shell path/);
  assert.match(discord, /Delete what you no longer need instead of filling it\./);
});
