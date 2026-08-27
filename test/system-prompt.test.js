import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDynamicRuntimeContext, buildStaticInstructions } from '../src/ai/systemPrompt.js';
import {
  _resetActiveProfileForTests
} from '../src/ai/providers/providerProfile.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { XAI_VOICES } from '../src/media/ttsCapabilities.js';
import {
  XAI_INLINE_VOICE_TAG_NAMES,
  XAI_WRAPPING_VOICE_TAG_NAMES
} from '../src/media/xaiVoiceTags.js';

const FIXTURE_MEMBERS = [{
  name: 'Fixture Member',
  wa: '390000000099@c.us',
  email: 'fixture@example.invalid'
}];

function regexAlternation(values) {
  return values.map(value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

const XAI_ONLY_PROMPT_MATERIAL = new RegExp(
  'render_inline_citation|Grok\\/SuperGrok|\\bxAI\\b|\\bx_search\\b|X posts|xai-tts'
    + `|\\b(?:${regexAlternation(XAI_VOICES)})\\b`
    + `|\\[(?:${regexAlternation(XAI_INLINE_VOICE_TAG_NAMES)})\\]`
    + `|<\\/?(?:${regexAlternation(XAI_WRAPPING_VOICE_TAG_NAMES)})>`,
  'i'
);

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
    userIdentity: { isActiveMember: true, isAdmin: true },
    userWorkspace: null
  });
  assert.match(runtime, /<Caller>Test Admin \(administrator, active member\)/);
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
    /<ActiveMembers>Fixture Member \(390000000099, fixture@example\.invalid\)<\/ActiveMembers>/
  );
  assert.match(promptFor(false), /<ActiveMembers>Fixture Member<\/ActiveMembers>/);
  assert.doesNotMatch(
    promptFor(false),
    /390000000099|fixture@example\.invalid/
  );
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
  const savedTts = envConfig.XAI_TTS_ENABLED;
  envConfig.XAI_TTS_ENABLED = true;
  try {
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
  } finally {
    envConfig.XAI_TTS_ENABLED = savedTts;
  }
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
  assert.match(prompt, /use `\/workspace\/\.\.\.` or `\/attachments\/\.\.\.`/);
  assert.match(prompt, /A 403 can be either a proxy policy rejection or the remote site refusing the request/);
  assert.doesNotMatch(prompt, /A 403 from it means the destination is not public/);
});
