// test/tool-catalog.test.js
//
// Platform composition is kept separate from the domain catalogs. Discord has
// the foundational workspace now, while WhatsApp-only product surfaces remain
// absent there.

import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import {
  PROFILE,
  TOOL,
  toolUnavailableMessage
} from '../src/config/platformCapabilities.js';
import { _resetActiveProfileForTests } from '../src/ai/providers/providerProfile.js';
import { TOOL_EXECUTORS } from '../src/tools/executors/index.js';
import { MEDIA_TOOL_EXECUTORS } from '../src/tools/executors/media.js';
import { WEB_TOOL_EXECUTORS } from '../src/tools/executors/web.js';

function names(tools) {
  return tools.map(tool => tool.function?.name || tool.type).filter(Boolean);
}

test('Discord exposes the full agentic workspace without inheriting WhatsApp-only tools', () => {
  const offered = names(getToolsForUser({
    isActiveMember: true,
    isAdmin: false,
    platform: constants.PLATFORM_DISCORD,
    isGroup: true
  }));

  for (const required of [
    'search_web',
    'read_page',
    'search_image',
    'list_files',
    'search_files',
    'read_file',
    'write_file',
    'edit_file',
    'shell',
    'generate_formal_request_pdf',
    'send_email',
    'send_whatsapp_message',
    'bug_report'
  ]) {
    assert.ok(offered.includes(required), `${required} should be available on Discord`);
  }

  for (const excluded of [
    'generate_image',
    'generate_video',
    'generate_music',
    'schedule_tasks',
    'read_my_tasks',
    'remove_my_tasks',
    'manage_preferences',
    'toggle_release_notify',
    'read_music_stats',
    'read_sent_messages'
  ]) {
    assert.equal(offered.includes(excluded), false, `${excluded} should stay off Discord`);
  }
});

test('catalog composition never emits duplicate tool identifiers', () => {
  for (const platform of [
    constants.PLATFORM_DISCORD,
    constants.PLATFORM_WA_DEDICATED,
    constants.PLATFORM_WA_PERSONAL
  ]) {
    const offered = names(getToolsForUser({
      isActiveMember: true,
      isAdmin: true,
      platform,
      isGroup: false
    }));
    assert.equal(new Set(offered).size, offered.length, platform);
  }
});

test('tool composition fails closed without an explicit supported platform', () => {
  assert.throws(() => getToolsForUser(), /explicit supported platform/);
  assert.throws(() => getToolsForUser({ platform: 'unknown' }), /explicit supported platform/);
});

test('every function offered by the complete context matrix has exactly one executor', () => {
  const savedProvider = envConfig.AI_PROVIDER;
  envConfig.AI_PROVIDER = 'xai';
  _resetActiveProfileForTests();
  try {
    const offered = new Set();
    for (const platform of [
      constants.PLATFORM_DISCORD,
      constants.PLATFORM_WA_DEDICATED,
      constants.PLATFORM_WA_PERSONAL
    ]) {
      for (const isGroup of [false, true]) {
        for (const isActiveMember of [false, true]) {
          for (const isAdmin of [false, true]) {
            for (const tool of getToolsForUser({ platform, isGroup, isActiveMember, isAdmin })) {
              if (tool.function?.name) offered.add(tool.function.name);
            }
          }
        }
      }
    }

    const actual = [...offered].sort();
    const registered = Object.keys(TOOL_EXECUTORS).sort();
    const declared = Object.values(TOOL).filter(name => name !== TOOL.X_SEARCH).sort();
    assert.deepEqual(registered, actual, 'executor registry drifted from live offered schemas');
    assert.deepEqual(declared, actual, 'capability constants drifted from live offered schemas');
  } finally {
    envConfig.AI_PROVIDER = savedProvider;
    _resetActiveProfileForTests();
  }
});

test('membership refusals describe the platform boundary accurately', () => {
  assert.equal(
    toolUnavailableMessage(TOOL.SEND_EMAIL, PROFILE.DISCORD_THREAD, { isActiveMember: false }),
    '"send_email" is only available to active server members.'
  );
  assert.equal(
    toolUnavailableMessage(TOOL.READ_SENT_MESSAGES, PROFILE.WA_DEDICATED_PRIVATE, { isActiveMember: false }),
    '"read_sent_messages" is only available to active server members on WhatsApp.'
  );
});

test('media and web executor domains do not contain misplaced tools', () => {
  assert.deepEqual(Object.keys(WEB_TOOL_EXECUTORS).sort(), [
    'read_page',
    'search_image',
    'search_web'
  ]);
  assert.deepEqual(Object.keys(MEDIA_TOOL_EXECUTORS).sort(), [
    'generate_image',
    'generate_music',
    'generate_video',
    'read_music_stats'
  ]);
});

test('workspace tools document line-cap recovery and shell working-directory path semantics', () => {
  const tools = getToolsForUser({
    isActiveMember: true,
    isAdmin: true,
    platform: constants.PLATFORM_WA_DEDICATED,
    isGroup: false
  });
  const readFile = tools.find(tool => tool.function?.name === 'read_file').function;
  const shell = tools.find(tool => tool.function?.name === 'shell').function;

  assert.match(readFile.description, /single line over the output cap/);
  assert.match(readFile.description, /byte-slice it with shell/);
  assert.match(shell.parameters.properties.command.description, /Without workingDir it runs at `\/`/);
  assert.match(shell.parameters.properties.command.description, /relative operands start there/);
  assert.match(shell.parameters.properties.workingDir.description, /use an absolute \/workspace/);
});

test('the skill library is described on WhatsApp and named nowhere on Discord', () => {
  const workspaceNames = new Set(['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'shell']);
  const ctx = { isActiveMember: true, isAdmin: true, isGroup: false };
  const descriptions = (platform) => getToolsForUser({ ...ctx, platform })
    .filter(tool => workspaceNames.has(tool.function?.name))
    .flatMap(tool => [
      tool.function.description,
      ...Object.values(tool.function.parameters?.properties || {}).map(p => p.description)
    ])
    .filter(Boolean)
    .join('\n');

  const wa = descriptions(constants.PLATFORM_WA_DEDICATED);
  assert.match(wa, /"skills\/<name>\/<file>" for the skill library/);
  // Readable, never a write target: workspace/ is the only root offered there.
  assert.match(wa, /under workspace\/, the one root you can write in/);
  assert.match(wa, /from attachments\/ or skills\/, copy it into workspace\//);
  assert.equal(/workspace\/ or skills\//.test(wa), false, wa);

  // On Discord `skills/` is not a root at all, so no schema may offer it.
  const discord = descriptions(constants.PLATFORM_DISCORD);
  assert.equal(/skills/i.test(discord), false, discord);
  assert.match(discord, /"attachments\/<file>" for files from this chat\./);
  assert.match(discord, /from attachments\/, copy it into workspace\//);
});
