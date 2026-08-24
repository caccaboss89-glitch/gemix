// test/tool-catalog.test.js
//
// Platform composition is kept separate from the domain catalogs. Discord has
// the foundational workspace now, while WhatsApp-only product surfaces remain
// absent there.

import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolsForUser } from '../src/ai/tools.js';
import constants from '../src/config/constants.js';
import { TOOL } from '../src/config/platformCapabilities.js';
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

test('every GemiX function tool has exactly one registered executor', () => {
  const expected = Object.values(TOOL)
    .filter(name => name !== TOOL.X_SEARCH)
    .sort();
  assert.deepEqual(Object.keys(TOOL_EXECUTORS).sort(), expected);
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
